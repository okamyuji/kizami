import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngramConfig } from '@/config';
import type { Store } from '@/db/store';
import { foldCanonicalHistory } from '@/jsonl/fold';
import { recoverPreparedCheckpoints } from '@/checkpoint/coordinator';
import { scanSessions } from '@/jsonl/deletion';
import type { compactSessions } from '@/jsonl/compact';
import { listJsonlFiles } from '@/jsonl/path';
import { deletionsFile, recordChunkSessions } from '@/archive/deletions';
import { REQUEST_COPY_SIGNATURE } from '@/parser/request-copy';
import { applyLegacy, findCopyTurns, planLegacy, trimTurns } from '@/hooks/request-copies-trim';
import type { CopyTurns, LegacyPlan } from '@/hooks/request-copies-trim';

export { REQUEST_COPY_SIGNATURE, stripRequestCopy } from '@/parser/request-copy';

/** 正本の JSONL では、本文の改行は \n と書かれる。 */
const RAW_SIGNATURE = Buffer.from(JSON.stringify(REQUEST_COPY_SIGNATURE).slice(1, -1));

/** 前回、直すものが無いと確かめた時の JSONL の各ファイル。 */
interface FileMark {
  file: string;
  identity: string;
  size: number;
  mtimeMs: number;
}

function stateFile(config: EngramConfig): string {
  return path.join(path.dirname(config.database.path), 'recover-request-copies.json');
}

/**
 * 読めない、または形の違う（以前の版の）ファイルは undefined を返し、正本全体を読む。
 * 項目の形は確かめない。形の違う項目は今のファイルと一致しないので、そのファイルは全体を読む。
 */
function loadMarks(config: EngramConfig): Map<string, FileMark> | undefined {
  let raw: unknown;
  try {
    // Stryker disable next-line StringLiteral: 文字コードを外すと Buffer が返るが、JSON.parse は文字列に直して読むので結果は同じ
    raw = JSON.parse(fs.readFileSync(stateFile(config), 'utf-8'));
  } catch {
    // 無い・壊れているときは正本全体を読む
  }
  const files = (raw as { files?: unknown } | null | undefined)?.files;
  if (!Array.isArray(files)) return undefined;
  return new Map((files as FileMark[]).map((m) => [m?.file, m]));
}

function currentMarks(files: string[]): FileMark[] {
  return files.map((file) => {
    const stat = fs.lstatSync(file);
    return {
      file: path.basename(file),
      identity: `${stat.dev}:${stat.ino}`,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  });
}

function saveMarks(config: EngramConfig, marks: FileMark[]): void {
  const file = stateFile(config);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ files: marks }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const sameMark = (a: FileMark | undefined, b: FileMark) =>
  a?.identity === b.identity && a.size === b.size && a.mtimeMs === b.mtimeMs;

function containsSignature(file: string, from: number, size: number): boolean {
  // Stryker disable next-line ArithmeticOperator: 大きく取っても読めるのはファイルの終わりまでで、残りは 0 のまま目印に当たらない
  const buffer = Buffer.alloc(size - from);
  const fd = fs.openSync(file, 'r');
  // Stryker disable BlockStatement: 閉じ忘れは fd が残るだけで、短命なプロセスの結果は変わらない
  try {
    fs.readSync(fd, buffer, 0, buffer.length, from);
  } finally {
    fs.closeSync(fd);
  }
  // Stryker restore BlockStatement
  return buffer.includes(RAW_SIGNATURE);
}

/** 前回から伸びた分だけを読む。置き換わったファイルと新しいファイルは全体を読む。 */
function hasNewCopies(files: string[], marks: FileMark[], saved: Map<string, FileMark>): boolean {
  return marks.some((mark, i) => {
    const prev = saved.get(mark.file);
    if (sameMark(prev, mark)) return false;
    const grown = prev?.identity === mark.identity && prev.size < mark.size;
    // 目印が前回の終わりをまたいでいても見つかるよう、目印の長さだけ手前から読む
    const from = grown ? Math.max(0, prev.size - RAW_SIGNATURE.length) : 0;
    return containsSignature(files[i], from, mark.size);
  });
}

export interface CopyRepairInput {
  config: EngramConfig;
  store: Store;
  compact: typeof compactSessions;
}

export interface CopyRepairResult {
  repaired: number;
  errors: number;
  details: string[];
}

/** 直したターンの数を、セッションごとに数える。 */
function countTurns(counts: Map<string, number>, sessionId: string, n: number): void {
  counts.set(sessionId, (counts.get(sessionId) ?? 0) + n);
}

function reportError(result: CopyRepairResult, label: string, err: unknown): void {
  result.errors++;
  result.details.push(`${label}: error - ${String(err)}`);
}

/** セッションごとに写しを除く。v1 は全セッション分の書き込みを最後にまとめる。失敗が無ければ true。 */
async function trimSessions(
  input: CopyRepairInput,
  copies: CopyTurns,
  deletedIds: Set<string>,
  result: CopyRepairResult
): Promise<boolean> {
  const { config, store } = input;
  const counts = new Map<string, number>();
  const failed = new Set<string>();
  try {
    const turns = [...copies.v2.values()].flat();
    const { left, dropped } = trimTurns(config, store, turns, deletedIds);
    const droppedCounts = new Map<string, number>();
    for (const turn of dropped) countTurns(droppedCounts, turn.sessionId, 1);
    for (const [sessionId, n] of droppedCounts) {
      result.details.push(
        `${sessionId.slice(0, 8)}: removed ${n} turn(s) from the DB that did not match the JSONL store; kizami rebuild restores it`
      );
    }
    for (const turn of left) {
      if (failed.has(turn.sessionId)) continue;
      failed.add(turn.sessionId);
      result.errors++;
      const id = turn.sessionId.slice(0, 8);
      result.details.push(`${id}: changed while it was being repaired, checked again next time`);
    }
    // 残したターンのセッションは failed に入れてあり、最後に数えない
    for (const [sessionId, list] of copies.v2) countTurns(counts, sessionId, list.length);
  } catch (err) {
    for (const sessionId of copies.v2.keys()) failed.add(sessionId);
    reportError(result, 'v2 turns', err);
  }
  const plans: LegacyPlan[] = [];
  for (const [sessionId, turns] of copies.v1) {
    try {
      plans.push(...turns.map((records) => planLegacy(store, records)));
      countTurns(counts, sessionId, turns.length);
    } catch (err) {
      failed.add(sessionId);
      reportError(result, sessionId.slice(0, 8), err);
    }
  }
  try {
    if (plans.length > 0) applyLegacy(config, store, plans, copies.legacyIds);
  } catch (err) {
    for (const plan of plans) failed.add(plan.sessionId);
    reportError(result, 'v1 rows', err);
  }
  for (const [sessionId, n] of counts) {
    if (failed.has(sessionId)) continue;
    result.repaired++;
    result.details.push(`${sessionId.slice(0, 8)} (trimmed ${n} ${n === 1 ? 'turn' : 'turns'})`);
  }
  return failed.size === 0;
}

/** 一覧に出る最初と最後の発言の要約も直す。以前の版の修復は chunk だけを直し、要約を残した。 */
function rebuildSummaries(store: Store, result: CopyRepairResult): boolean {
  try {
    for (const sessionId of store.sessionsWithSummaryContaining('<system-reminder>')) {
      store.recomputeSessionMetadata(sessionId);
    }
    return true;
  } catch (err) {
    reportError(result, 'session summaries', err);
    return false;
  }
}

function purgeIndex(store: Store, result: CopyRepairResult): boolean {
  try {
    store.purgeDeletedIndexEntries();
    return true;
  } catch (err) {
    reportError(result, 'full-text index', err);
    return false;
  }
}

async function compactTargets(
  input: CopyRepairInput,
  targets: Set<string>,
  result: CopyRepairResult
): Promise<boolean> {
  if (targets.size === 0) return true;
  try {
    return (await input.compact(input.config.storage.jsonlDir, targets)) !== 'retry';
  } catch (err) {
    result.errors++;
    result.details.push(`JSONL compaction: error - ${String(err)}`);
    return false;
  }
}

function lockFile(config: EngramConfig): string {
  return path.join(path.dirname(config.database.path), 'recover-request-copies.lock');
}

/** 修復は数秒で終わる。これより古いロックは、pid が別のプロセスに使い回されていても持ち主がいないとみなす。 */
const LOCK_STALE_MS = 10 * 60 * 1000;

/** ロックを持つプロセスが動いているか。読めない、数でない、終わったプロセス、古すぎるロックなら false。 */
function holderAlive(file: string): boolean {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) return false;
    process.kill(Number(fs.readFileSync(file)), 0);
    return true;
  } catch (err) {
    // 別のユーザーのプロセスには信号を送れないが、動いてはいる
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function createLock(file: string): boolean {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
}

/**
 * 修復は recall hook のたびに裏で走る recover から呼ばれるので、2 つが同時に直さないようにロックを取る。
 * 取れなければ undefined を返す。落ちたプロセスが残したロックは取り直す。
 */
function acquireLock(config: EngramConfig): (() => void) | undefined {
  const file = lockFile(config);
  const created = createLock(file);
  if (!created) {
    if (holderAlive(file)) return undefined;
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: 持ち主を確かめた後に別のプロセスが消す競合は、決定的に再現できない
    fs.rmSync(file, { force: true });
    // 同時に取り直した別のプロセスが先なら、そちらに任せる
    // Stryker disable next-line ConditionalExpression: 消してから作り直すまでの間に別のプロセスが作る競合は、決定的に再現できない
    if (!createLock(file)) return undefined;
  }
  // 10 分を過ぎて別のプロセスに取り直されたロックは、そのプロセスのものなので消さない
  return () => {
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: 持ち主を確かめた後に別のプロセスが消す競合は、決定的に再現できない
    if (holderIsMe(file)) fs.rmSync(file, { force: true });
  };
}

function holderIsMe(file: string): boolean {
  try {
    // Stryker disable BlockStatement: catch を空にすると undefined が返り、false と同じく消さない
    return fs.readFileSync(file, 'utf-8') === String(process.pid);
  } catch {
    return false;
  }
}

// Stryker restore BlockStatement
async function repairAll(
  input: CopyRepairInput,
  files: string[],
  marks: FileMark[],
  result: CopyRepairResult
) {
  const { config } = input;
  const jsonlDir = config.storage.jsonlDir;
  // 済んだ保存の receipt は写しを含む元の取引をそのまま持つので片付ける。途中の receipt は正本に書き終えてから fold に入れる
  await recoverPreparedCheckpoints(config);
  const history = await foldCanonicalHistory(files);
  if (history.errors.length > 0) {
    const reasons = history.errors.map((e) => e.message).join('; ');
    throw new Error(`JSONL store has invalid transactions, so nothing was repaired: ${reasons}`);
  }
  const scan = await scanSessions(jsonlDir, REQUEST_COPY_SIGNATURE);
  recordChunkSessions(deletionsFile(config.database.path), scan.deletedSessions);
  const copies = findCopyTurns(history, scan.starting);
  const trimmed = await trimSessions(input, copies, scan.deletedIds, result);
  const summarized = rebuildSummaries(input.store, result);
  // 写しを含むセッションは、正本の記録に目印を持つので containing に入る
  const compacted = await compactTargets(input, scan.containing, result);
  const purged = purgeIndex(input.store, result);
  // 読む前の位置を残す。修復の間に増えた分は読んでいないので、次の回に読む
  if (trimmed && summarized && compacted && purged) saveMarks(config, marks);
}

/**
 * api-request-blob の写しを発言として保存したターンから、写しだけを除く。本物のプロンプトと回答は残す。
 * 正本の JSONL を fold した結果から探すので、DB から消えた会話や v1 の長いターンも直る。
 * 直した後は JSONL 正本から古い記録を物理的に消す。すべて済んだ時だけ各ファイルの位置を記録し、
 * 次の回は伸びた分に写しの目印が無ければ何もしない。
 */
export async function repairRequestCopies(input: CopyRepairInput): Promise<CopyRepairResult> {
  const result: CopyRepairResult = { repaired: 0, errors: 0, details: [] };
  const { config } = input;
  const jsonlDir = config.storage.jsonlDir;
  const saved = loadMarks(config);
  const files = listJsonlFiles(jsonlDir);
  const marks = currentMarks(files);
  if (saved && !hasNewCopies(files, marks, saved)) {
    // 次の回に、伸びた分だけを読むため
    saveMarks(config, marks);
    return result;
  }

  const release = acquireLock(config);
  if (!release) return result;
  try {
    await repairAll(input, files, marks, result);
  } finally {
    release();
  }
  return result;
}
