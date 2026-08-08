import { createHash } from 'node:crypto';
import type {
  JsonlV2Payload,
  JsonlV2Record,
  SerializedJsonlTransaction,
  ValidatedTransactionFrame,
} from './types';

export const MAX_JSONL_RECORD_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !isStringArray(value.filePaths) ||
    !isStringArray(value.toolNames) ||
    !isStringArray(value.errorMessages)
  ) {
    return false;
  }
  return (
    (value.sourceRuntime === undefined || typeof value.sourceRuntime === 'string') &&
    (value.captureMethod === undefined || typeof value.captureMethod === 'string') &&
    (value.turnId === undefined || value.turnId === null || typeof value.turnId === 'string') &&
    (value.model === undefined || value.model === null || typeof value.model === 'string')
  );
}

function isObservationBoundary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'source_offset') {
    return isNonNegativeInteger(value.generation) && isNonNegativeInteger(value.offset);
  }
  return value.kind === 'delivery_sequence' && isNonNegativeInteger(value.sequence);
}

function isTurnPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.partIndex) &&
    typeof value.externalId === 'string' &&
    typeof value.content === 'string' &&
    (value.role === 'human' || value.role === 'assistant' || value.role === 'mixed') &&
    isMetadata(value.metadata) &&
    isNonNegativeInteger(value.tokenCount)
  );
}

function isExecution(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.executionIndex) &&
    typeof value.toolName === 'string' &&
    typeof value.command === 'string' &&
    (value.status === 'failed' || value.status === 'succeeded' || value.status === 'unknown') &&
    (value.exitCode === undefined || isFiniteNumber(value.exitCode)) &&
    typeof value.outputExcerpt === 'string'
  );
}

function isTurnCheckpointPayload(value: Record<string, unknown>): boolean {
  return (
    typeof value.txId === 'string' &&
    typeof value.sessionId === 'string' &&
    (value.runtime === 'claude' || value.runtime === 'codex' || value.runtime === 'kimi') &&
    typeof value.turnKey === 'string' &&
    typeof value.sourceOrder === 'string' &&
    isObservationBoundary(value.observedThrough) &&
    isNonNegativeInteger(value.historyEpoch) &&
    isNonNegativeInteger(value.revision) &&
    typeof value.contentHash === 'string' &&
    typeof value.completedAt === 'string' &&
    typeof value.projectPath === 'string' &&
    Array.isArray(value.parts) &&
    value.parts.every(isTurnPart) &&
    (value.executions === undefined ||
      (Array.isArray(value.executions) && value.executions.every(isExecution)))
  );
}

export function isJsonlV2Payload(value: unknown): value is JsonlV2Payload {
  if (!isRecord(value) || value.v !== 2) return false;
  if (value.type === 'session_reset') {
    return (
      typeof value.txId === 'string' &&
      typeof value.sessionId === 'string' &&
      isNonNegativeInteger(value.historyEpoch) &&
      value.reason === 'legacy_mismatch'
    );
  }
  return value.type === 'turn_checkpoint' && isTurnCheckpointPayload(value);
}

export function isJsonlV2Record(value: unknown): value is JsonlV2Record {
  if (!isRecord(value) || value.v !== 2 || typeof value.txId !== 'string') return false;
  if (value.type === 'tx_begin') return typeof value.createdAt === 'string';
  if (value.type === 'tx_commit') {
    return (
      isNonNegativeInteger(value.recordCount) &&
      typeof value.payloadDigest === 'string' &&
      typeof value.createdAt === 'string'
    );
  }
  return isJsonlV2Payload(value);
}

export function serializeV2Transaction(
  payloads: JsonlV2Payload[],
  options: { txId: string; createdAt: string; targetPath: string }
): SerializedJsonlTransaction {
  const { txId, createdAt, targetPath } = options;

  const beginRecord: JsonlV2Record = { v: 2, type: 'tx_begin', txId, createdAt };
  // Ensure all payload txIds match the transaction txId
  const normalizedPayloads = payloads.map((p) => ({ ...p, txId }));
  const payloadLines = normalizedPayloads.map((p) => JSON.stringify(p));
  for (const payloadLine of payloadLines) {
    if (Buffer.byteLength(payloadLine, 'utf-8') > MAX_JSONL_RECORD_BYTES) {
      throw new Error(`JSONL transaction record exceeds ${MAX_JSONL_RECORD_BYTES} bytes`);
    }
  }
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
    records: [beginRecord, ...normalizedPayloads, commitRecord],
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

  if (!isJsonlV2Record(begin) || begin.type !== 'tx_begin') return undefined;
  if (!isJsonlV2Record(commit) || commit.type !== 'tx_commit') return undefined;
  if (begin.txId !== commit.txId) return undefined;
  if (commit.recordCount !== payloadLines.length) return undefined;

  const digest = computePayloadDigest(payloadLines);
  if (commit.payloadDigest !== digest) return undefined;

  if (typeof begin.createdAt !== 'string') return undefined;
  if (typeof commit.payloadDigest !== 'string') return undefined;

  const payloads: JsonlV2Payload[] = [];
  for (const line of payloadLines) {
    const parsed = safeParse(line);
    if (!parsed || !isJsonlV2Payload(parsed)) return undefined;
    if (parsed.txId !== begin.txId) return undefined;
    payloads.push(parsed);
  }

  return {
    txId: begin.txId,
    createdAt: begin.createdAt,
    payloadDigest: commit.payloadDigest,
    payloads,
  };
}

export function computePayloadDigest(payloadLines: string[]): string {
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
