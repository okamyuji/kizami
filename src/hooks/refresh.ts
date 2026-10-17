import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngramConfig } from '@/config';
import type { Session, Store } from '@/db/store';
import { parseTranscript, conversationTime, hasRequestCopies } from '@/parser/transcript';
import type { TranscriptMessage } from '@/parser/transcript';
import { isAgedOut } from '@/maintenance/auto';
import { buildChunks } from '@/parser/chunker';
import { contentDigest } from '@/archive/deletions';
import { readPendingPrompts } from '@/checkpoint/state';
import { buildClaudeTurnCandidates } from '@/checkpoint/adapters/claude';
import { commitCheckpointBatch } from '@/checkpoint/coordinator';
import type { TurnCheckpointCandidate } from '@/checkpoint/types';

/** 取り込んだときの生ログのサイズ。サイズが同じなら解析せずに済ませる。 */
export type RecoverMarks = Map<string, number>;

function marksFile(config: EngramConfig): string {
  return path.join(path.dirname(config.database.path), 'recover-state.json');
}

export function loadRecoverMarks(config: EngramConfig): RecoverMarks {
  const file = marksFile(config);
  let raw: { sizes?: Record<string, unknown> } | null | undefined;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { sizes?: Record<string, unknown> } | null;
  } catch {
    // 目印は解析を省くためだけのもの。無い・壊れているときは空として全件を解析し直し、検索は止めない。
  }
  const entries = Object.entries(raw?.sizes ?? {}).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number'
  );
  return new Map(entries);
}

export function saveRecoverMarks(config: EngramConfig, marks: RecoverMarks): void {
  const file = marksFile(config);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sizes: Object.fromEntries(marks) }));
  fs.renameSync(tmp, file);
}

function repairMarkerFile(config: EngramConfig): string {
  return path.join(path.dirname(config.database.path), 'recover-repaired');
}

/** 時刻と projectPath の修復を済ませたか。済みなら保存済みセッションの cwd を読み直さない。 */
export function isRepairDone(config: EngramConfig): boolean {
  return fs.existsSync(repairMarkerFile(config));
}

export function markRepairDone(config: EngramConfig): void {
  try {
    // 'wx' は既存のパスに失敗する。目印の位置に置かれたシンボリックリンクの先を、切り詰めない
    fs.closeSync(fs.openSync(repairMarkerFile(config), 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

function copyRetriesFile(config: EngramConfig): string {
  return path.join(path.dirname(config.database.path), 'recover-request-copies.json');
}

/**
 * api-request-blob の写しの修復で、確かめ直すセッション。ファイルが無いか壊れていれば undefined を返し、全件を確かめる。
 * 一度確かめたセッションを毎回置き換えると JSONL が伸び続けるので、見送ったものと失敗したものだけを残す。
 */
export function loadCopyRepairRetries(config: EngramConfig): Set<string> | undefined {
  let raw: unknown;
  try {
    // Stryker disable next-line StringLiteral: 文字コードを外すと Buffer が返り、JSON.parse は同じ文字列として読む
    raw = JSON.parse(fs.readFileSync(copyRetriesFile(config), 'utf-8'));
  } catch {
    return undefined;
  }
  return new Set(Array.isArray(raw) ? (raw as string[]) : []);
}

export function saveCopyRepairRetries(config: EngramConfig, sessionIds: Set<string>): void {
  const file = copyRetriesFile(config);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...sessionIds]));
  fs.renameSync(tmp, file);
}

export type RefreshOutcome = 'refreshed' | 'unchanged' | 'skipped';

interface RefreshContext {
  config: EngramConfig;
  store: Store;
  sessionId: string;
  transcriptPath: string;
  marks: RecoverMarks;
  deletedChunkDigests: Set<string>;
}

async function commit(
  config: EngramConfig,
  sessionId: string,
  candidates: TurnCheckpointCandidate[],
  reset: boolean
): Promise<void> {
  await commitCheckpointBatch(
    {
      runtime: 'claude',
      sessionId,
      candidates,
      ...(reset ? { resetReason: 'legacy_mismatch' as const } : {}),
      // Stryker disable next-line ArrayDeclaration: coordinator は runtime の pending ディレクトリ外のパスを消さないので、中身を変えても何も起きない
      finalization: { pendingPaths: [] },
    },
    config
  );
}

/** 時刻の無いターンには会話の最後の時刻を使う。どの行にも無ければ生ログの更新時刻を使う。 */
function fallbackTime(messages: TranscriptMessage[], mtime: Date): string {
  return conversationTime([...messages].reverse().find((m) => m.timestamp)?.timestamp, mtime);
}

// 取り込み時刻が刻まれた v1 の行を見分ける閾値。hook の保存は会話の終了から数分以内に着く。
const IMPORT_STAMP_GAP_MS = 60 * 60 * 1000;

function needsRepair(store: Store, session: Session, projectPath: string): boolean {
  if (session.projectPath !== projectPath) return true;
  // v1 の行が無いと開始時刻は undefined になり、NaN との比較は false になる
  const start = Date.parse(String(store.getLegacyChunkStart(session.sessionId)));
  return start - Date.parse(String(session.endedAt)) > IMPORT_STAMP_GAP_MS;
}

/**
 * 古い実装は projectPath をディレクトリ名から誤って復号し、チャンクに取り込み時刻を刻んだ。
 * そのセッションを、生ログから作り直した全ターンで置き換える。判定が外れれば何もしない。
 * v1 の行だけのセッションに限る。hook は同じ offset 鍵を付けるため、鍵を持つセッションは hook の管理下にあり触らない。
 */
export async function repairIfMisdated(ctx: RefreshContext, projectPath: string): Promise<boolean> {
  const { config, store, sessionId } = ctx;
  const session = store.getSession(sessionId);
  if (!session || store.getSessionTurnKeys(sessionId).length > 0) return false;
  if (!needsRepair(store, session, projectPath)) return false;
  // 保持期間より古い会話は、直しても整理で消える。取り込み時刻の行は保持期間の後に消え、入れ直されない
  if (isAgedOut(config, session.endedAt)) return false;
  if (hasPendingPrompt(ctx)) return false;
  return replaceFromTranscript(ctx, projectPath);
}

export type RequestCopyRepair = 'repaired' | 'skipped' | 'deferred';

/**
 * 0.8.5 以前は api-request-blob 行（API へ送った本文の写し）を発言として保存した。写しは system-reminder を含む。
 * system-reminder を含むチャンクがあり、生ログに写しの行があるセッションを、生ログから作り直した全ターンで置き換える。
 * 写しで行の番号がずれ、保存済みの turnKey は作り直したターンと合わないので、hook の管理下のセッションも置き換える。
 * 書きかけのターンがあれば deferred を返す。呼び出し側は確かめ直す一覧に残す。
 */
export async function repairIfRequestCopies(
  ctx: RefreshContext,
  projectPath: string
): Promise<RequestCopyRepair> {
  if (!ctx.store.hasChunkContaining(ctx.sessionId, '<system-reminder>')) return 'skipped';
  if (!(await hasRequestCopies(ctx.transcriptPath))) return 'skipped';
  if (hasPendingPrompt(ctx)) return 'deferred';
  return (await replaceFromTranscript(ctx, projectPath)) ? 'repaired' : 'skipped';
}

function hasPendingPrompt(ctx: RefreshContext): boolean {
  const stateRoot = path.dirname(ctx.config.database.path);
  return readPendingPrompts(stateRoot, 'claude', ctx.sessionId).length > 0;
}

/**
 * セッションを、生ログから作り直した全ターンで置き換える。削除したチャンクを戻す場合と、応答のあるターンが無い場合は何もしない。
 * 置き換えは legacy_mismatch の reset として JSONL に残るので、rebuild しても直した値が残る。
 */
async function replaceFromTranscript(ctx: RefreshContext, projectPath: string): Promise<boolean> {
  const { config, sessionId, transcriptPath, marks } = ctx;
  const { size, mtime } = fs.statSync(transcriptPath);
  const messages = await parseTranscript(transcriptPath);
  const chunks = buildChunks(messages, sessionId, projectPath);
  if (chunks.some((c) => ctx.deletedChunkDigests.has(contentDigest(c.content)))) return false;
  const candidates = buildClaudeTurnCandidates(
    messages,
    sessionId,
    projectPath,
    size,
    fallbackTime(messages, mtime)
  );
  if (candidates.length === 0) return false;

  await commit(config, sessionId, candidates, true);
  marks.set(sessionId, size);
  return true;
}

/**
 * recover が取り込んだ後に生ログが伸びたセッションへ、伸びた分を反映する。
 * v1 の行が残るセッションは全ターンの v2 baseline で置き換える。v2 だけのセッションは、
 * DB の turnKey がすべて offset:<n> の規則で作られている場合に限り、足りないターンを足す。
 * それ以外の turnKey（未処理の prompt から作る pending:<key>）があれば hook が管理しているので触らない。
 * チャンクの無いセッション行は、保存済みとして扱い触らない。
 * 削除したチャンクを含むセッションも触らない。置き換えると新しい ID で本文が戻るため。
 */
export async function refreshIfGrown(ctx: RefreshContext): Promise<RefreshOutcome> {
  const { store, sessionId, transcriptPath, marks } = ctx;
  const { size, mtime } = fs.statSync(transcriptPath);
  if (marks.get(sessionId) === size) return 'unchanged';
  if (hasPendingPrompt(ctx)) return 'skipped';
  const session = store.getSession(sessionId);
  if (!session) return 'skipped';

  const messages = await parseTranscript(transcriptPath);
  const chunks = buildChunks(messages, sessionId, session.projectPath);
  // 解析した時点のサイズを残し、変わらない生ログを次の検索で解析し直さない。
  marks.set(sessionId, size);
  if (chunks.some((c) => ctx.deletedChunkDigests.has(contentDigest(c.content)))) return 'skipped';
  const candidates = buildClaudeTurnCandidates(
    messages,
    sessionId,
    session.projectPath,
    size,
    fallbackTime(messages, mtime)
  );

  // hook が後から足した v2 の行は数えない。混在していれば v1 より生ログのチャンクが多くなり、置き換わる。
  const legacyRows = store.countLegacyRows(sessionId);
  // セッション行は checkpoint の反映時に recomputeSessionMetadata が集計し直す。
  return legacyRows > 0
    ? replaceLegacy(ctx, chunks.length, legacyRows, candidates)
    : appendMissingTurns(ctx, candidates);
}

async function replaceLegacy(
  ctx: RefreshContext,
  chunkCount: number,
  legacyRows: number,
  candidates: TurnCheckpointCandidate[]
): Promise<RefreshOutcome> {
  if (chunkCount <= legacyRows) return 'unchanged';
  await commit(ctx.config, ctx.sessionId, candidates, true);
  return 'refreshed';
}

async function appendMissingTurns(
  ctx: RefreshContext,
  candidates: TurnCheckpointCandidate[]
): Promise<RefreshOutcome> {
  const known = new Set(candidates.map((c) => c.turnKey));
  const existing = new Set(ctx.store.getSessionTurnKeys(ctx.sessionId));
  if (existing.size === 0 || [...existing].some((key) => !known.has(key))) return 'skipped';
  const missing = candidates.filter((c) => !existing.has(c.turnKey));
  if (missing.length === 0) return 'unchanged';
  await commit(ctx.config, ctx.sessionId, missing, false);
  return 'refreshed';
}
