import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type {
  JsonlChunkRecord,
  JsonlLineResult,
  JsonlRecord,
  CanonicalTransactionResult,
  CommittedTransaction,
} from '@/jsonl/types';
import { validateCommittedTransaction } from '@/jsonl/transaction';

/**
 * JSONLを行単位でstreaming読み込みする。
 * - 不正な行（JSON parse失敗、v/typeが想定外）はスキップしカウントする
 * - 戻り値は AsyncIterable<JsonlChunkRecord>
 */
export async function* readJsonlFile(
  filePath: string
): AsyncGenerator<JsonlChunkRecord, void, void> {
  if (!fs.existsSync(filePath)) return;

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isJsonlChunkRecord(parsed)) continue;
    yield parsed;
  }
}

export function isJsonlChunkRecord(value: unknown): value is JsonlChunkRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<JsonlRecord>;
  return (
    v.v === 1 &&
    v.type === 'chunk' &&
    typeof v.id === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.projectPath === 'string' &&
    typeof v.chunkIndex === 'number' &&
    typeof v.content === 'string' &&
    typeof v.createdAt === 'string'
  );
}

/**
 * 末尾N行を効率的に読む（self-healing用）。
 * ファイル全体を読まず、末尾チャンクからのみパースする実装。
 */
export function readTailRecords(filePath: string, n: number): JsonlChunkRecord[] {
  if (!fs.existsSync(filePath) || n <= 0) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.length > 0);
  const tail = lines.slice(-n);
  const out: JsonlChunkRecord[] = [];
  for (const line of tail) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isJsonlChunkRecord(parsed)) out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export async function* readJsonlLines(filePath: string): AsyncGenerator<JsonlLineResult> {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  let offset = 0;

  for (const line of content.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf-8');
    const endOffset = offset + lineBytes + 1; // +1 for newline
    if (!line.trim()) {
      offset = endOffset;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      yield { kind: 'diagnostic', offset, endOffset, line, message: 'invalid JSON' };
      offset = endOffset;
      continue;
    }

    if (!parsed || typeof parsed !== 'object') {
      yield { kind: 'diagnostic', offset, endOffset, line, message: 'not an object' };
      offset = endOffset;
      continue;
    }

    const record = parsed as Record<string, unknown>;
    if (record.v === 1 && isJsonlChunkRecord(parsed)) {
      yield { kind: 'record', offset, endOffset, line, record: parsed };
    } else if (record.v === 2 && typeof record.type === 'string') {
      yield { kind: 'record', offset, endOffset, line, record: parsed as JsonlRecord };
    } else {
      yield { kind: 'diagnostic', offset, endOffset, line, message: 'unknown record version/type' };
    }
    offset = endOffset;
  }
}

export async function* readCanonicalTransactions(
  filePath: string
): AsyncGenerator<CanonicalTransactionResult> {
  let activeBegin: { offset: number; line: string; txId: string } | undefined;
  let activePayloadLines: string[] = [];

  for await (const result of readJsonlLines(filePath)) {
    if (result.kind === 'diagnostic') continue;

    const { record, offset, line } = result;
    if (!('v' in record) || record.v !== 2) continue;

    if (record.type === 'tx_begin') {
      if (activeBegin) {
        yield {
          kind: 'diagnostic',
          filePath,
          offset: activeBegin.offset,
          txId: activeBegin.txId,
          message: 'abandoned frame: new tx_begin before commit',
        };
      }
      activeBegin = { offset, line, txId: record.txId };
      activePayloadLines = [];
      continue;
    }

    if (record.type === 'tx_commit') {
      if (!activeBegin) {
        yield {
          kind: 'diagnostic',
          filePath,
          offset,
          txId: record.txId,
          message: 'orphan tx_commit without tx_begin',
        };
        continue;
      }

      const frame = validateCommittedTransaction(activeBegin.line, activePayloadLines, line);
      if (frame) {
        const tx: CommittedTransaction = {
          txId: frame.txId,
          createdAt: frame.createdAt,
          filePath,
          beginOffset: activeBegin.offset,
          endOffset: result.endOffset,
          payloadDigest: frame.payloadDigest,
          payloads: frame.payloads,
        };
        yield { kind: 'transaction', transaction: tx };
      } else {
        yield {
          kind: 'diagnostic',
          filePath,
          offset: activeBegin.offset,
          txId: activeBegin.txId,
          message: 'invalid transaction frame',
        };
      }
      activeBegin = undefined;
      activePayloadLines = [];
      continue;
    }

    if (activeBegin) {
      activePayloadLines.push(line);
    }
  }

  if (activeBegin) {
    yield {
      kind: 'diagnostic',
      filePath,
      offset: activeBegin.offset,
      txId: activeBegin.txId,
      message: 'incomplete transaction at EOF',
    };
  }
}
