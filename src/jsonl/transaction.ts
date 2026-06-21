import { createHash } from 'node:crypto';
import type {
  JsonlV2Payload,
  JsonlV2Record,
  SerializedJsonlTransaction,
  ValidatedTransactionFrame,
} from './types';

export function serializeV2Transaction(
  payloads: JsonlV2Payload[],
  options: { txId: string; createdAt: string; targetPath: string }
): SerializedJsonlTransaction {
  const { txId, createdAt, targetPath } = options;

  const beginRecord: JsonlV2Record = { v: 2, type: 'tx_begin', txId, createdAt };
  const payloadLines = payloads.map((p) => JSON.stringify(p));
  const payloadDigest = computePayloadDigest(payloadLines);

  const commitRecord: JsonlV2Record = {
    v: 2,
    type: 'tx_commit',
    txId,
    recordCount: payloads.length,
    payloadDigest,
    createdAt,
  };

  const beginLine = JSON.stringify(beginRecord);
  const commitLine = JSON.stringify(commitRecord);

  return {
    txId,
    createdAt,
    targetPath,
    payloadLines,
    payloadDigest,
    allLines: [beginLine, ...payloadLines, commitLine],
    records: [beginRecord, ...payloads, commitRecord],
  };
}

export function validateCommittedTransaction(
  beginLine: string,
  payloadLines: string[],
  commitLine: string
): ValidatedTransactionFrame | undefined {
  const begin = safeParse(beginLine);
  const commit = safeParse(commitLine);
  if (!begin || !commit) return undefined;

  if (begin.v !== 2 || begin.type !== 'tx_begin' || typeof begin.txId !== 'string')
    return undefined;
  if (commit.v !== 2 || commit.type !== 'tx_commit' || typeof commit.txId !== 'string')
    return undefined;
  if (begin.txId !== commit.txId) return undefined;
  if (commit.recordCount !== payloadLines.length) return undefined;

  const digest = computePayloadDigest(payloadLines);
  if (commit.payloadDigest !== digest) return undefined;

  const payloads: JsonlV2Payload[] = [];
  for (const line of payloadLines) {
    const parsed = safeParse(line);
    if (!parsed || !isV2Payload(parsed)) return undefined;
    payloads.push(parsed as JsonlV2Payload);
  }

  return {
    txId: begin.txId as string,
    createdAt: typeof begin.createdAt === 'string' ? (begin.createdAt as string) : '',
    payloadDigest: commit.payloadDigest as string,
    payloads,
  };
}

function computePayloadDigest(payloadLines: string[]): string {
  const text = payloadLines.join('\n') + '\n';
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function safeParse(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return undefined;
}

function isV2Payload(obj: Record<string, unknown>): boolean {
  return obj.v === 2 && (obj.type === 'session_reset' || obj.type === 'turn_checkpoint');
}
