import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, applyProjectAlias } from '@/config';
import type { EngramConfig } from '@/config';
import { getClaudeProjectsDir } from '@/archive/store';
import { readHeader } from '@/archive/resolve';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { parseTranscript, conversationTime } from '@/parser/transcript';
import type { UserMessage } from '@/parser/transcript';
import { buildChunks } from '@/parser/chunker';
import { JsonlWriter } from '@/jsonl/writer';
import { chunksToJsonlRecords } from '@/jsonl/converter';
import { loadDeletions, deletionsFile, contentDigest } from '@/archive/deletions';
import type { Deletions } from '@/archive/deletions';
import { isAgedOut } from '@/maintenance/auto';
import type { RecoverMarks } from '@/hooks/refresh';
import {
  loadRecoverMarks,
  saveRecoverMarks,
  refreshIfGrown,
  repairIfMisdated,
  repairIfRequestCopies,
  isRepairDone,
  markRepairDone,
  loadCopyRepairRetries,
  saveCopyRepairRetries,
} from '@/hooks/refresh';

export interface RecoverResult {
  recovered: number;
  refreshed: number;
  repaired: number;
  skipped: number;
  errors: number;
  details: string[];
}

/**
 * プロジェクトディレクトリ名からプロジェクトパスを復元する。
 * POSIX:   "-Users-yujiokamoto-devs-claude" → "/Users/yujiokamoto/devs/claude"
 * Windows: "C--Users-me-proj"               → "C:\\Users\\me\\proj"
 *
 * 注意: この復号は不可逆である。"-" を無条件に区切りへ戻すため、ディレクトリ名に
 * 元から含まれる "-" と "." も潰れる (".claude" → "/claude")。
 */
const WINDOWS_PROJECT_DIR_RE = /^([A-Za-z])--(.*)$/;

export function projectDirToPath(dirName: string): string {
  // Windows: ディレクトリ名はドライブレターで始まる ("C--Users-me-proj")。
  // POSIX と同じ解釈をすると slice(1) がドライブレターを食ってしまう。
  const windows = WINDOWS_PROJECT_DIR_RE.exec(dirName);
  if (windows) {
    const [, drive, rest] = windows;
    return `${drive.toUpperCase()}:\\${rest.replace(/-/g, '\\')}`;
  }
  // 先頭の "-" はルートの "/" に対応
  // 残りの "-" はパスの "/" に対応
  return '/' + dirName.slice(1).replace(/-/g, '/');
}

/**
 * 生ログに記録された cwd を優先し、無いときだけディレクトリ名から復号する。
 * hook の保存と同じく realpath を通し、同じプロジェクトが別のパスに分かれないようにする。
 */
async function resolveProjectPath(
  config: EngramConfig,
  transcriptPath: string,
  dirName: string
): Promise<string> {
  const { cwd } = await readHeader(transcriptPath);
  if (!cwd) return applyProjectAlias(config.storage.projectAliases, projectDirToPath(dirName));
  let resolved = cwd;
  try {
    resolved = fs.realpathSync(cwd);
  } catch {
    // 別マシンで記録されたパスなど、このホストに無い cwd はそのまま使う
  }
  return applyProjectAlias(config.storage.projectAliases, resolved);
}

interface Scan {
  config: EngramConfig;
  store: Store;
  marks: RecoverMarks;
  deleted: Deletions;
  result: RecoverResult;
  repairDone: boolean;
  repairFailed: boolean;
  /** undefined なら全件を確かめる。 */
  copyRetries: Set<string> | undefined;
  copyRetryNext: Set<string>;
}

/** 保存済みのセッションを、修復が要れば作り直し、生ログが伸びていれば反映する。 */
async function syncSavedSession(
  scan: Scan,
  sessionId: string,
  transcriptPath: string,
  dirName: string
): Promise<void> {
  const { config, store, marks, result } = scan;
  const ctx = {
    config,
    store,
    sessionId,
    transcriptPath,
    marks,
    deletedChunkDigests: scan.deleted.chunkDigests,
  };
  const checkCopies = scan.copyRetries?.has(sessionId) ?? true;
  if (checkCopies && (await repairRequestCopies(scan, ctx, dirName))) return;
  if (!scan.repairDone) {
    let repaired: boolean;
    try {
      repaired = await repairIfMisdated(
        ctx,
        await resolveProjectPath(config, transcriptPath, dirName)
      );
    } catch (err) {
      scan.repairFailed = true;
      throw err;
    }
    if (repaired) {
      result.repaired++;
      result.details.push(`${sessionId.slice(0, 8)} (repaired)`);
      return;
    }
  }
  if ((await refreshIfGrown(ctx)) === 'refreshed') {
    result.refreshed++;
    result.details.push(`${sessionId.slice(0, 8)} (refreshed)`);
  } else {
    result.skipped++;
  }
}

/** api-request-blob の写しを発言として保存したセッションを作り直す。直したら true。 */
async function repairRequestCopies(
  scan: Scan,
  ctx: Parameters<typeof repairIfRequestCopies>[0],
  dirName: string
): Promise<boolean> {
  let outcome: Awaited<ReturnType<typeof repairIfRequestCopies>>;
  try {
    outcome = await repairIfRequestCopies(
      ctx,
      await resolveProjectPath(scan.config, ctx.transcriptPath, dirName)
    );
  } catch (err) {
    scan.copyRetryNext.add(ctx.sessionId);
    throw err;
  }
  if (outcome === 'deferred') scan.copyRetryNext.add(ctx.sessionId);
  if (outcome !== 'repaired') return false;
  scan.result.repaired++;
  scan.result.details.push(`${ctx.sessionId.slice(0, 8)} (repaired)`);
  return true;
}

/** DB に無いセッションを生ログから取り込む。 */
async function importTranscript(
  scan: Scan,
  sessionId: string,
  transcriptPath: string,
  dirName: string
): Promise<void> {
  const { config, store, marks, result } = scan;
  // 解析より先に測る。解析中に追記された分を、取り込み済みとして記録しないため。
  const { size, mtime } = fs.statSync(transcriptPath);
  // 取り込まないと決めた生ログ、整理や削除で行が消えた生ログは、伸びるまで読み直さない。recover は毎プロンプト走る
  // 保持期間を無効にした後は、期間外として見送った生ログも取り込むので目印を見ない
  if (config.maintenance.enabled && marks.get(sessionId) === size) {
    result.skipped++;
    return;
  }
  const messages = await parseTranscript(transcriptPath);
  const projectPath = await resolveProjectPath(config, transcriptPath, dirName);
  const chunks = buildChunks(messages, sessionId, projectPath);
  // 時刻の無いターンに取り込み時刻を刻むと、古い会話が最新として並ぶ。生ログの更新時刻を使う
  for (const c of chunks) c.createdAt ??= conversationTime(undefined, mtime);
  const newest = chunks
    .map((c) => c.createdAt)
    .sort()
    .pop();
  if (
    chunks.length === 0 ||
    // 整理はチャンクの created_at で消すので、最も新しいチャンクで判定する。外れると消えては入るを繰り返す
    isAgedOut(config, newest) ||
    // rebuild で全チャンクを消したセッションは行ごと無くなる。取り込み直すと削除した本文が戻る。
    chunks.some((c) => scan.deleted.chunkDigests.has(contentDigest(c.content)))
  ) {
    marks.set(sessionId, size);
    result.skipped++;
    return;
  }

  const writer = new JsonlWriter(config.storage.jsonlDir);
  writer.appendRecords(chunksToJsonlRecords(chunks));
  store.insertChunks(chunks);

  const humans = messages.filter((m): m is UserMessage => m.kind === 'user');
  store.insertSession({
    sessionId,
    projectPath,
    startedAt: conversationTime(messages[0].timestamp, mtime),
    endedAt: conversationTime(messages[messages.length - 1].timestamp, mtime),
    chunkCount: chunks.length,
    firstMessage: humans[0]?.text.slice(0, 200),
    lastMessage: humans[humans.length - 1]?.text.slice(0, 200),
  });

  marks.set(sessionId, size);
  result.recovered++;
  result.details.push(`${sessionId.slice(0, 8)} (${chunks.length} chunks)`);
}

/**
 * ~/.claude/projects/ 配下のトランスクリプトファイルを走査し、
 * DBに未保存のセッションを検出して保存する。
 */
export async function recoverTranscripts(
  configPath?: string,
  claudeProjectsDir?: string,
  config: EngramConfig = loadConfig(configPath)
): Promise<RecoverResult> {
  const db = getDatabase(config.database.path);

  const result: RecoverResult = {
    recovered: 0,
    refreshed: 0,
    repaired: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  try {
    initializeSchema(db);
    const scan: Scan = {
      config,
      store: new Store(db),
      marks: loadRecoverMarks(config),
      deleted: loadDeletions(deletionsFile(config.database.path)),
      result,
      repairDone: isRepairDone(config),
      repairFailed: false,
      copyRetries: loadCopyRepairRetries(config),
      copyRetryNext: new Set(),
    };

    const projectsDir = claudeProjectsDir ?? getClaudeProjectsDir();
    if (!fs.existsSync(projectsDir)) {
      return result;
    }

    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });

    for (const dirent of projectDirs) {
      if (!dirent.isDirectory()) continue;

      const projectDir = path.join(projectsDir, dirent.name);

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

        const sessionId = entry.name.replace(/\.jsonl$/, '');
        const transcriptPath = path.join(projectDir, entry.name);

        if (scan.deleted.sessions.has(sessionId)) {
          result.skipped++;
          continue;
        }
        try {
          if (scan.store.hasSession(sessionId)) {
            await syncSavedSession(scan, sessionId, transcriptPath, dirent.name);
          } else {
            await importTranscript(scan, sessionId, transcriptPath, dirent.name);
          }
        } catch (err) {
          // refresh は解析した時点で目印を立てる。反映に失敗したら外し、次の実行で再試行させる。
          scan.marks.delete(sessionId);
          result.errors++;
          result.details.push(`${sessionId.slice(0, 8)}: error - ${String(err)}`);
        }
      }
    }

    saveRecoverMarks(config, scan.marks);
    // 修復の判定に失敗したセッションがあれば次回も判定し直す。取り込みの失敗は関係ない
    if (!scan.repairDone && !scan.repairFailed) markRepairDone(config);
    if (scan.copyRetries?.size !== 0) saveCopyRepairRetries(config, scan.copyRetryNext);
    return result;
  } finally {
    db.close();
  }
}
