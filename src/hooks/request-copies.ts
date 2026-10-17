import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngramConfig } from '@/config';
import type { Store } from '@/db/store';
import { deleteChunkEverywhere } from '@/archive/deletions';
import { scanSessions } from '@/jsonl/deletion';
import type { compactSessions } from '@/jsonl/compact';
import { replaceFromTranscript } from '@/hooks/refresh';
import { readPendingPrompts } from '@/checkpoint/state';
import type { RecoverMarks } from '@/hooks/refresh';

/**
 * Claude Code が API へ送った本文の写し（api-request-blob 行）を発言として保存したチャンクの書き出し。
 * 写しは system-reminder で始まる。実データでは、正規の会話のチャンクはこの形で始まらなかった。
 */
export const REQUEST_COPY_SIGNATURE = '[User]\n<system-reminder>';

/** これより古い書きかけのプロンプトは、hook が保存し終えることのない、落ちたセッションの残りとみなす。 */
const PENDING_STALE_MS = 24 * 60 * 60 * 1000;

/** 確かめ直すセッションと、正本の圧縮をやり直すセッション。 */
interface CopyRepairState {
  retry: Set<string>;
  compact: Set<string>;
}

export interface CopyRepairInput {
  config: EngramConfig;
  store: Store;
  marks: RecoverMarks;
  deletedChunkDigests: Set<string>;
  projectsDir: string;
  resolveProjectPath: (transcriptPath: string, dirName: string) => Promise<string>;
  compact: typeof compactSessions;
}

export interface CopyRepairResult {
  repaired: number;
  errors: number;
  details: string[];
}

function stateFile(config: EngramConfig): string {
  return path.join(path.dirname(config.database.path), 'recover-request-copies.json');
}

/** ファイルが無いか読めなければ undefined を返し、全件を確かめる。 */
function loadState(config: EngramConfig): CopyRepairState | undefined {
  let raw: { retry?: unknown; compact?: unknown } | null;
  try {
    raw = JSON.parse(fs.readFileSync(stateFile(config), 'utf-8')) as typeof raw;
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  const ids = (value: unknown) => new Set(Array.isArray(value) ? (value as string[]) : []);
  return { retry: ids(raw.retry), compact: ids(raw.compact) };
}

function saveState(config: EngramConfig, state: CopyRepairState): void {
  const file = stateFile(config);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = { retry: [...state.retry], compact: [...state.compact] };
  fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function* transcriptsUnder(root: string): Generator<[string, { path: string; dirName: string }]> {
  // ディレクトリでないものは readDirents が空を返す
  for (const dir of readDirents(root)) {
    for (const entry of readDirents(path.join(root, dir.name))) {
      // シンボリックリンクの生ログは、recover の取り込みと同じく読まない
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      yield [sessionId, { path: path.join(root, dir.name, entry.name), dirName: dir.name }];
    }
  }
}

/** セッション ID から生ログを引く。Claude Code の生ログを先に、消えていれば kizami の保管を使う。 */
function findTranscripts(roots: string[]): Map<string, { path: string; dirName: string }> {
  const found = new Map<string, { path: string; dirName: string }>();
  for (const root of roots) {
    for (const [sessionId, transcript] of transcriptsUnder(root)) {
      if (!found.has(sessionId)) found.set(sessionId, transcript);
    }
  }
  return found;
}

function readDirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 写しを含むセッションを直す。生ログを読み直せて、手で消したチャンクが無ければ全ターンを作り直す。
 * 手で消したチャンクがあると、作り直しで消した本文が戻るので、写しを含むターンだけを消す。
 * 生ログが無いときと、作り直すと応答のあるターンが残らないときも、写しを含むターンを消す。
 */
/** hook が書きかけのターンを保存し終えるのを待つべきか。時刻が読めないものは待つ。 */
function waitingForHook(config: EngramConfig, sessionId: string): boolean {
  const stateRoot = path.dirname(config.database.path);
  return readPendingPrompts(stateRoot, 'claude', sessionId).some(
    (p) => !(Date.now() - Date.parse(p.createdAt) >= PENDING_STALE_MS)
  );
}

async function repairSession(
  input: CopyRepairInput,
  sessionId: string,
  transcript: { path: string; dirName: string } | undefined,
  handDeleted: boolean
): Promise<'repaired' | 'purged'> {
  const { config, store, marks, deletedChunkDigests } = input;
  if (transcript && !handDeleted) {
    const ctx = {
      config,
      store,
      sessionId,
      transcriptPath: transcript.path,
      marks,
      deletedChunkDigests,
    };
    const projectPath = await input.resolveProjectPath(transcript.path, transcript.dirName);
    if (await replaceFromTranscript(ctx, projectPath)) return 'repaired';
  }
  for (const chunk of store.getChunksOfTurnsContaining(sessionId, REQUEST_COPY_SIGNATURE)) {
    deleteChunkEverywhere(store, config, chunk);
  }
  return 'purged';
}

async function repairCandidates(
  input: CopyRepairInput,
  candidates: string[],
  next: CopyRepairState,
  result: CopyRepairResult
): Promise<void> {
  const { config } = input;
  const scan = await scanSessions(config.storage.jsonlDir, REQUEST_COPY_SIGNATURE);
  // DB では直っていても正本に写しが残るセッション（以前の置き換えの残り）も圧縮する
  for (const id of scan.containing) next.compact.add(id);
  const transcripts = findTranscripts([input.projectsDir, config.storage.transcriptArchiveDir]);
  for (const sessionId of candidates) {
    try {
      const outcome = await repairSession(
        input,
        sessionId,
        transcripts.get(sessionId),
        scan.handDeleted.has(sessionId)
      );
      next.compact.add(sessionId);
      result.repaired++;
      result.details.push(`${sessionId.slice(0, 8)} (${outcome})`);
    } catch (err) {
      next.retry.add(sessionId);
      result.errors++;
      result.details.push(`${sessionId.slice(0, 8)}: error - ${String(err)}`);
    }
  }
}

async function compactPending(
  input: CopyRepairInput,
  next: CopyRepairState,
  result: CopyRepairResult
): Promise<void> {
  // Stryker disable next-line ConditionalExpression: 空の対象で正本全体を読み直さないための近道。外しても結果は unchanged で同じ
  if (next.compact.size === 0) return;
  try {
    if ((await input.compact(input.config.storage.jsonlDir, next.compact)) !== 'retry') {
      next.compact.clear();
    }
  } catch (err) {
    result.errors++;
    result.details.push(`JSONL compaction: error - ${String(err)}`);
  }
}

/**
 * api-request-blob の写しを発言として保存したセッションを DB で直し、JSONL 正本からも写しを消す。
 * 初回は全件を確かめ、書きかけで見送ったもの、失敗したもの、圧縮を差し替えられなかったものだけを次回に回す。
 */
export async function repairRequestCopies(input: CopyRepairInput): Promise<CopyRepairResult> {
  const result: CopyRepairResult = { repaired: 0, errors: 0, details: [] };
  const saved = loadState(input.config);
  if (saved && saved.retry.size === 0 && saved.compact.size === 0) return result;

  const { config, store } = input;
  const next: CopyRepairState = { retry: new Set(), compact: new Set(saved?.compact) };
  // 再試行の回は残した ID だけを確かめる。全件の検索は本文全体を読むので、毎回は走らせない
  const candidates = saved
    ? [...saved.retry].filter((id) => store.hasChunkContaining(id, REQUEST_COPY_SIGNATURE))
    : store.sessionsWithChunkContaining(REQUEST_COPY_SIGNATURE);
  const ready = candidates.filter((id) => !waitingForHook(config, id));
  for (const id of candidates) if (!ready.includes(id)) next.retry.add(id);
  // 初回は、DB では直っていても正本に写しが残るセッションを探すために、候補が無くても正本を読む
  if (!saved || ready.length > 0) await repairCandidates(input, ready, next, result);
  await compactPending(input, next, result);
  saveState(input.config, next);
  return result;
}
