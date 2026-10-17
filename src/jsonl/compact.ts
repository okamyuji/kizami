import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { listJsonlFiles } from './path';
import { readCanonicalTransactions, readJsonlLines } from './reader';
import { serializeV2Transaction } from './transaction';
import { foldCanonicalHistory } from './fold';
import type { CanonicalHistory } from './fold';
import { JsonlTransactionWriter } from './writer';
import type { CommittedTransaction, JsonlV2Payload } from './types';

export type CompactOutcome = 'compacted' | 'unchanged' | 'retry';

type Checkpoint = Extract<JsonlV2Payload, { type: 'turn_checkpoint' }>;

/** fold と同じ規則で、採用しない記録を決めるための集計。 */
interface Facts {
  resets: Set<string>;
  maxEpoch: Map<string, number>;
  maxRevision: Map<string, number>;
  deleted: Set<string>;
}

/** バイト範囲 [begin, end) を lines で置き換える。lines が空なら消す。 */
interface Edit {
  begin: number;
  end: number;
  lines: string[];
}

interface FilePlan {
  file: string;
  identity: string;
  size: number;
  edits: Edit[];
}

const turnId = (p: Checkpoint) => JSON.stringify([p.sessionId, p.turnKey, p.historyEpoch]);

function addFact(facts: Facts, p: JsonlV2Payload): void {
  if (p.type === 'chunk_delete') {
    facts.deleted.add(p.externalId);
  } else if (p.type === 'session_reset') {
    facts.resets.add(p.sessionId);
    facts.maxEpoch.set(p.sessionId, Math.max(facts.maxEpoch.get(p.sessionId) ?? 0, p.historyEpoch));
  } else {
    const id = turnId(p);
    facts.maxRevision.set(id, Math.max(facts.maxRevision.get(id) ?? 0, p.revision));
  }
}

/** fold が errors を返した正本は先に拒むので、ここに来る診断は EOF の書きかけの枠だけになる。 */
async function* transactions(file: string): AsyncGenerator<CommittedTransaction> {
  for await (const result of readCanonicalTransactions(file)) {
    if (result.kind === 'transaction') yield result.transaction;
  }
}

async function collectFacts(files: string[]): Promise<Facts> {
  const facts: Facts = {
    resets: new Set(),
    maxEpoch: new Map(),
    maxRevision: new Map(),
    deleted: new Set(),
  };
  for (const file of files) {
    for await (const tx of transactions(file)) for (const p of tx.payloads) addFact(facts, p);
  }
  return facts;
}

/** fold が採用しない checkpoint なら undefined、削除済みの part を除いたなら新しい payload を返す。 */
function keptCheckpoint(p: Checkpoint, facts: Facts): Checkpoint | undefined {
  const maxEpoch = facts.maxEpoch.get(p.sessionId) ?? p.historyEpoch;
  if (facts.resets.has(p.sessionId) && p.historyEpoch !== maxEpoch) return undefined;
  if (p.revision < (facts.maxRevision.get(turnId(p)) ?? p.revision)) return undefined;
  const parts = p.parts.filter((part) => !facts.deleted.has(part.externalId));
  if (parts.length === 0) return undefined;
  return parts.length === p.parts.length ? p : { ...p, parts };
}

function frameEdit(
  tx: CommittedTransaction,
  targets: Set<string>,
  facts: Facts,
  original: Buffer
): Edit | undefined {
  // 枠の中に別の行が挟まっていると、置き換えでその行まで消える。そのような枠には触らない
  const lineCount =
    original.subarray(tx.beginOffset, tx.endOffset).toString().split('\n').length - 1;
  if (lineCount !== tx.payloads.length + 2) return undefined;
  const kept: JsonlV2Payload[] = [];
  for (const p of tx.payloads) {
    const next =
      p.type === 'turn_checkpoint' && targets.has(p.sessionId) ? keptCheckpoint(p, facts) : p;
    if (next) kept.push(next);
  }
  if (kept.length === tx.payloads.length && kept.every((p, i) => p === tx.payloads[i])) {
    return undefined;
  }
  const lines =
    kept.length === 0
      ? []
      : serializeV2Transaction(kept, {
          txId: tx.txId,
          createdAt: tx.createdAt,
          targetPath: tx.filePath,
        }).allLines;
  return { begin: tx.beginOffset, end: tx.endOffset, lines };
}

async function planFile(
  file: string,
  targets: Set<string>,
  facts: Facts
): Promise<FilePlan | undefined> {
  // 解析中に追記されても、差し替えの前にサイズが合わなくなるので swap が見送る
  const stat = fs.lstatSync(file);
  const original = fs.readFileSync(file);
  const edits: Edit[] = [];
  for await (const result of readJsonlLines(file)) {
    // Stryker disable next-line ConditionalExpression: 行の診断がある正本は fold の errors で先に拒むので、ここでは常に record
    if (result.kind !== 'record' || result.record.v !== 1) continue;
    const record = result.record;
    if (!targets.has(record.sessionId)) continue;
    if (facts.resets.has(record.sessionId) || facts.deleted.has(record.id)) {
      edits.push({ begin: result.offset, end: result.endOffset, lines: [] });
    }
  }
  for await (const tx of transactions(file)) {
    const edit = frameEdit(tx, targets, facts, original);
    if (edit) edits.push(edit);
  }
  if (edits.length === 0) return undefined;
  edits.sort((a, b) => a.begin - b.begin);
  return { file, identity: `${stat.dev}:${stat.ino}`, size: stat.size, edits };
}

function writeCompacted(plan: FilePlan): string {
  const original = fs.readFileSync(plan.file);
  const pieces: Buffer[] = [];
  let cursor = 0;
  for (const edit of plan.edits) {
    pieces.push(original.subarray(cursor, edit.begin));
    if (edit.lines.length > 0) pieces.push(Buffer.from(edit.lines.join('\n') + '\n'));
    cursor = edit.end;
  }
  pieces.push(original.subarray(cursor));
  const tmp = `${plan.file}.compact-${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  // Stryker disable BlockStatement: 閉じ忘れは fd が残るだけで、短命なプロセスの書いた内容は変わらない
  try {
    fs.writeSync(fd, Buffer.concat(pieces));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Stryker restore BlockStatement
  return tmp;
}

function sameHistory(a: CanonicalHistory, b: CanonicalHistory): boolean {
  // 古い revision を消すと、そのターンが Map に入る順番が後ろへずれる。順番は比べない。
  // reset の記録は消さないので比べない
  const view = (h: CanonicalHistory) =>
    JSON.stringify([[...h.turns.entries()].sort(), h.legacyChunks, h.errors]);
  return view(a) === view(b);
}

// Stryker disable BlockStatement: fsync 抜けは電源断のときだけ差が出て、閉じ忘れは fd が残るだけ。テストでは観測できない
function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
// Stryker restore BlockStatement

/** 解析した時から元ファイルが変わっていなければ差し替える。ロックの中で呼ぶ。 */
function replaceUnchanged(jsonlDir: string, plans: FilePlan[], tmps: string[]): boolean {
  for (const plan of plans) {
    const stat = fs.lstatSync(plan.file);
    if (`${stat.dev}:${stat.ino}` !== plan.identity || stat.size !== plan.size) return false;
  }
  plans.forEach((plan, i) => fs.renameSync(tmps[i], plan.file));
  fsyncDir(jsonlDir);
  return true;
}

function swap(jsonlDir: string, plans: FilePlan[], tmps: string[]): boolean {
  const writer = new JsonlTransactionWriter(jsonlDir);
  // Stryker disable BlockStatement: 閉じ忘れは接続が残るだけで、短命なプロセスの結果は変わらない
  try {
    return writer.withExclusiveTransaction(() => replaceUnchanged(jsonlDir, plans, tmps));
  } finally {
    writer.close();
  }
  // Stryker restore BlockStatement
}

/**
 * 指定したセッションについて、fold が採用しない本文を JSONL 正本から物理的に消す。
 * 消すのは reset 済みセッションの v1 行、古い epoch の checkpoint、同じ epoch の古い revision、削除済みの part。
 * 書き換えた内容を fold し直して結果が変わらないことを確かめてから、ロックの中で差し替える。
 * 解析から差し替えまでに追記があれば何も変えずに retry を返す。
 */
export async function compactSessions(
  jsonlDir: string,
  targets: Set<string>
): Promise<CompactOutcome> {
  const files = listJsonlFiles(jsonlDir);
  const before = await foldCanonicalHistory(files);
  if (before.errors.length > 0) {
    const reasons = before.errors.map((e) => e.message).join('; ');
    throw new Error(`JSONL store has invalid transactions, so nothing was compacted: ${reasons}`);
  }
  const facts = await collectFacts(files);
  const plans: FilePlan[] = [];
  for (const file of files) {
    const plan = await planFile(file, targets, facts);
    if (plan) plans.push(plan);
  }
  if (plans.length === 0) return 'unchanged';

  const tmps: string[] = [];
  try {
    for (const plan of plans) tmps.push(writeCompacted(plan));
    const replaced = new Map(plans.map((plan, i) => [plan.file, tmps[i]]));
    const after = await foldCanonicalHistory(files.map((f) => replaced.get(f) ?? f));
    if (!sameHistory(before, after)) {
      throw new Error('Compaction would change the folded history, so nothing was compacted.');
    }
    return swap(jsonlDir, plans, tmps) ? 'compacted' : 'retry';
  } finally {
    for (const tmp of tmps) fs.rmSync(tmp, { force: true });
  }
}
