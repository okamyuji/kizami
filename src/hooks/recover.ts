import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig, applyProjectAlias } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { parseTranscript } from '@/parser/transcript';
import { buildChunks } from '@/parser/chunker';
import { JsonlWriter } from '@/jsonl/writer';
import { chunksToJsonlRecords } from '@/jsonl/converter';
import { loadDeletions, deletionsFile, contentDigest } from '@/archive/deletions';
import { loadRecoverMarks, saveRecoverMarks, refreshIfGrown } from '@/hooks/refresh';

export interface RecoverResult {
  recovered: number;
  refreshed: number;
  skipped: number;
  errors: number;
  details: string[];
}

function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
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
 * ~/.claude/projects/ 配下のトランスクリプトファイルを走査し、
 * DBに未保存のセッションを検出して保存する。
 */
export async function recoverTranscripts(
  configPath?: string,
  claudeProjectsDir?: string
): Promise<RecoverResult> {
  const config = loadConfig(configPath);
  const db = getDatabase(config.database.path);

  const result: RecoverResult = {
    recovered: 0,
    refreshed: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  try {
    initializeSchema(db);
    const store = new Store(db);
    const deleted = loadDeletions(deletionsFile(config.database.path));
    const marks = loadRecoverMarks(config);

    const projectsDir = claudeProjectsDir ?? getClaudeProjectsDir();
    if (!fs.existsSync(projectsDir)) {
      return result;
    }

    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });

    for (const dirent of projectDirs) {
      if (!dirent.isDirectory()) continue;

      const projectDir = path.join(projectsDir, dirent.name);
      const projectPath = applyProjectAlias(
        config.storage.projectAliases,
        projectDirToPath(dirent.name)
      );

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

        if (deleted.sessions.has(sessionId)) {
          result.skipped++;
          continue;
        }
        try {
          if (store.hasSession(sessionId)) {
            const outcome = await refreshIfGrown({
              config,
              store,
              sessionId,
              transcriptPath,
              marks,
              deletedChunkDigests: deleted.chunkDigests,
            });
            if (outcome === 'refreshed') {
              result.refreshed++;
              result.details.push(`${sessionId.slice(0, 8)} (refreshed)`);
            } else {
              result.skipped++;
            }
            continue;
          }

          // 解析より先に測る。解析中に追記された分を、取り込み済みとして記録しないため。
          const size = fs.statSync(transcriptPath).size;
          const messages = await parseTranscript(transcriptPath);
          if (messages.length === 0) {
            result.skipped++;
            continue;
          }

          const chunks = buildChunks(messages, sessionId, projectPath);
          // rebuild で全チャンクを消したセッションは行ごと無くなる。取り込み直すと削除した本文が戻る。
          if (
            chunks.length === 0 ||
            chunks.some((c) => deleted.chunkDigests.has(contentDigest(c.content)))
          ) {
            result.skipped++;
            continue;
          }

          const writer = new JsonlWriter(config.storage.jsonlDir);
          writer.appendRecords(chunksToJsonlRecords(chunks));
          store.insertChunks(chunks);

          const firstHuman = messages.find((m) => m.kind === 'user');
          const lastHuman = [...messages].reverse().find((m) => m.kind === 'user');

          store.insertSession({
            sessionId,
            projectPath,
            startedAt: messages[0].timestamp,
            endedAt: messages[messages.length - 1].timestamp,
            chunkCount: chunks.length,
            firstMessage: firstHuman?.kind === 'user' ? firstHuman.text.slice(0, 200) : undefined,
            lastMessage: lastHuman?.kind === 'user' ? lastHuman.text.slice(0, 200) : undefined,
          });

          marks.set(sessionId, size);
          result.recovered++;
          result.details.push(`${sessionId.slice(0, 8)} (${chunks.length} chunks)`);
        } catch (err) {
          // refresh は解析した時点で目印を立てる。反映に失敗したら外し、次の実行で再試行させる。
          marks.delete(sessionId);
          result.errors++;
          result.details.push(`${sessionId.slice(0, 8)}: error - ${String(err)}`);
        }
      }
    }

    saveRecoverMarks(config, marks);
    return result;
  } finally {
    db.close();
  }
}
