import type { EngramConfig } from '@/config';
import type {
  CheckpointCommitResult,
  HookRuntime,
  TurnCheckpointCandidate,
  TurnCheckpointV2,
} from './types';
import type { AdapterExtraction } from './adapter';
import type { PreparedCheckpointV2 } from './state';
import {
  MAX_INITIAL_PREPARED_RECEIPT_BYTES,
  MAX_PREPARED_RECEIPT_BYTES,
  writePreparedCheckpoint,
  updatePreparedPhase,
  removePendingPrompt,
  writeRuntimeCursor,
  finalizePreparedCheckpoint,
  markPreparedSuperseded,
} from './state';
import { buildCheckpointParts } from './builder';
import { hashFields, createContentHash, compareObservationBoundary } from './identity';
import {
  MAX_JSONL_RECORD_BYTES,
  serializeV2Transaction,
  validateCommittedTransaction,
} from '@/jsonl/transaction';
import { JsonlTransactionWriter } from '@/jsonl/writer';
import type { CanonicalTurnHead } from '@/jsonl/writer';
import type { JsonlV2Payload } from '@/jsonl/types';
import { getJsonlFilePath } from '@/jsonl/path';
import { Store } from '@/db/store';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { enforcePrivateDirectory, readPrivateTextFile } from '@/storage/permissions';

const MAX_PREPARED_PAYLOAD_RECORDS = 4096;
const PREPARED_TRANSACTION_FRAME_RESERVE_BYTES = 4096;

export interface CheckpointBatch {
  runtime: HookRuntime;
  sessionId: string;
  candidates: TurnCheckpointCandidate[];
  resetReason?: 'legacy_mismatch';
  finalization: AdapterExtraction['finalization'];
}

interface ValidatedRecoveryReceipt {
  phase: PreparedCheckpointV2['phase'];
  txId: string;
  runtime: HookRuntime;
  sessionId: string;
  targetPath: string;
  payloadDigest: string;
  historyEpoch: number;
  allLines: string[];
  payloads: JsonlV2Payload[];
  turnKeys: string[];
  pendingPaths: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPreparedPhase(value: unknown): value is PreparedCheckpointV2['phase'] {
  return (
    value === 'prepared' ||
    value === 'jsonl_committed' ||
    value === 'sqlite_applied' ||
    value === 'finalized' ||
    value === 'superseded'
  );
}

function isHookRuntime(value: unknown): value is HookRuntime {
  return value === 'claude' || value === 'codex' || value === 'kimi';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function assertPreparedTransactionBounds(allLines: string[]): void {
  if (allLines.length < 3 || allLines.length > MAX_PREPARED_PAYLOAD_RECORDS + 2) {
    throw new Error(`Prepared receipt exceeds ${MAX_PREPARED_PAYLOAD_RECORDS} payload records`);
  }
  if (allLines.some((line) => Buffer.byteLength(line, 'utf-8') > MAX_JSONL_RECORD_BYTES)) {
    throw new Error(`Prepared receipt contains a line larger than ${MAX_JSONL_RECORD_BYTES} bytes`);
  }
}

function assertPreparedReceiptCanBeRecovered(receipt: PreparedCheckpointV2): void {
  assertPreparedTransactionBounds(receipt.allLines);
  if (Buffer.byteLength(JSON.stringify(receipt), 'utf-8') > MAX_INITIAL_PREPARED_RECEIPT_BYTES) {
    throw new Error(`Prepared receipt exceeds ${MAX_INITIAL_PREPARED_RECEIPT_BYTES} bytes`);
  }
}

function assertPayloadsFitPreparedReceipt(
  payloads: JsonlV2Payload[],
  receiptWithoutLines: Omit<PreparedCheckpointV2, 'allLines' | 'payloadDigest'>
): void {
  const skeleton: PreparedCheckpointV2 = {
    ...receiptWithoutLines,
    payloadDigest: '',
    allLines: ['', '', ''],
  };
  let projectedBytes =
    Buffer.byteLength(JSON.stringify(skeleton), 'utf-8') + PREPARED_TRANSACTION_FRAME_RESERVE_BYTES;
  for (const payload of payloads) {
    const payloadLine = JSON.stringify(payload);
    if (Buffer.byteLength(payloadLine, 'utf-8') > MAX_JSONL_RECORD_BYTES) {
      throw new Error(`JSONL transaction record exceeds ${MAX_JSONL_RECORD_BYTES} bytes`);
    }
    projectedBytes += Buffer.byteLength(JSON.stringify(payloadLine), 'utf-8') + 1;
    if (projectedBytes > MAX_INITIAL_PREPARED_RECEIPT_BYTES) {
      throw new Error(`Prepared receipt exceeds ${MAX_INITIAL_PREPARED_RECEIPT_BYTES} bytes`);
    }
  }
}

function parseRecoveryReceipt(filePath: string): ValidatedRecoveryReceipt {
  const parsed: unknown = JSON.parse(readPrivateTextFile(filePath, MAX_PREPARED_RECEIPT_BYTES));
  if (!isObject(parsed) || !isObject(parsed.finalization)) {
    throw new Error('Invalid prepared receipt structure');
  }
  if (
    parsed.version !== 2 ||
    !isPreparedPhase(parsed.phase) ||
    typeof parsed.txId !== 'string' ||
    !isHookRuntime(parsed.runtime) ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.targetPath !== 'string' ||
    typeof parsed.payloadDigest !== 'string' ||
    !isStringArray(parsed.allLines) ||
    !isStringArray(parsed.finalization.pendingPaths)
  ) {
    throw new Error('Invalid prepared receipt fields');
  }

  const allLines = parsed.allLines;
  assertPreparedTransactionBounds(allLines);
  const frame = validateCommittedTransaction(
    allLines[0],
    allLines.slice(1, -1),
    allLines[allLines.length - 1]
  );
  if (
    !frame ||
    frame.txId !== parsed.txId ||
    frame.payloadDigest !== parsed.payloadDigest ||
    frame.payloads.some(
      (payload) =>
        payload.sessionId !== parsed.sessionId ||
        (payload.type === 'turn_checkpoint' && payload.runtime !== parsed.runtime)
    )
  ) {
    throw new Error('Prepared receipt does not match its validated transaction');
  }
  const historyEpoch = frame.payloads[0]?.historyEpoch;
  if (
    historyEpoch === undefined ||
    frame.payloads.some((payload) => payload.historyEpoch !== historyEpoch)
  ) {
    throw new Error('Prepared receipt contains inconsistent history epochs');
  }

  return {
    phase: parsed.phase,
    txId: parsed.txId,
    runtime: parsed.runtime,
    sessionId: parsed.sessionId,
    targetPath: parsed.targetPath,
    payloadDigest: parsed.payloadDigest,
    historyEpoch,
    allLines,
    payloads: frame.payloads,
    turnKeys: frame.payloads
      .filter((payload) => payload.type === 'turn_checkpoint')
      .map((payload) => payload.turnKey),
    pendingPaths: parsed.finalization.pendingPaths,
  };
}

function validateRecoveryPaths(
  receipt: ValidatedRecoveryReceipt,
  config: EngramConfig,
  stateRoot: string
): void {
  const targetPath = path.resolve(receipt.targetPath);
  const jsonlDir = path.resolve(config.storage.jsonlDir);
  if (
    path.dirname(targetPath) !== jsonlDir ||
    !path.basename(targetPath).endsWith('.jsonl') ||
    path.basename(targetPath).startsWith('.')
  ) {
    throw new Error('Prepared receipt target is not a canonical JSONL file');
  }

  const pendingDir = path.resolve(stateRoot, 'pending', receipt.runtime);
  for (const pendingPath of receipt.pendingPaths) {
    const resolvedPendingPath = path.resolve(pendingPath);
    if (
      path.dirname(resolvedPendingPath) !== pendingDir ||
      !path.basename(resolvedPendingPath).endsWith('.json') ||
      path.basename(resolvedPendingPath).startsWith('.')
    ) {
      throw new Error('Prepared receipt pending path is outside its runtime directory');
    }
  }
}

function canonicalHeadCoversCheckpoint(
  head: CanonicalTurnHead,
  checkpoint: TurnCheckpointV2
): boolean {
  if (head.historyEpoch !== checkpoint.historyEpoch) {
    return head.historyEpoch > checkpoint.historyEpoch;
  }

  const boundaryComparison = compareObservationBoundary(
    checkpoint.observedThrough,
    head.observedThrough
  );
  if (boundaryComparison === 'older') return true;
  if (boundaryComparison !== 'equal') return false;
  if (head.revision !== checkpoint.revision) return head.revision > checkpoint.revision;
  return head.contentHash === checkpoint.contentHash;
}

function getStateRoot(config: EngramConfig): string {
  return path.dirname(config.database.path);
}

function candidateToolResults(candidate: TurnCheckpointCandidate): string[] {
  const results: string[] = [];
  for (const msg of candidate.messages) {
    if (msg.kind === 'assistant' && 'toolResults' in msg) {
      for (const tr of msg.toolResults) {
        results.push(typeof tr === 'string' ? tr : JSON.stringify(tr));
      }
    }
  }
  return results;
}

function buildTxId(
  sessionId: string,
  historyEpoch: number,
  isReset: boolean,
  turnData: Array<{ turnKey: string; revision: number; contentHash: string }>
): string {
  const sorted = [...turnData]
    .map((t) => hashFields(t.turnKey, String(t.revision), t.contentHash))
    .sort();

  const fields: Array<string | number> = [sessionId];
  if (isReset) fields.push('legacy_reset');
  fields.push(String(historyEpoch));
  fields.push(...sorted);

  return hashFields(...fields);
}

export async function commitCheckpointBatch(
  batch: CheckpointBatch,
  config: EngramConfig
): Promise<CheckpointCommitResult[]> {
  const jsonlDir = config.storage.jsonlDir;
  const stateRoot = getStateRoot(config);
  const txWriter = new JsonlTransactionWriter(jsonlDir);

  try {
    const results: CheckpointCommitResult[] = [];
    const checkpoints: TurnCheckpointV2[] = [];

    const committed = txWriter.withExclusiveTransaction((lockedWriter) => {
      const reconcile = lockedWriter.reconcileCanonicalIndex();
      if (reconcile.status !== 'ready') {
        for (const c of batch.candidates) {
          results.push({ status: 'deferred', turnKey: c.turnKey, reason: reconcile.reason });
        }
        return null;
      }

      const historyEpoch = batch.resetReason
        ? lockedWriter.allocateSessionEpoch(batch.sessionId)
        : lockedWriter.getSessionEpoch(batch.sessionId);

      const payloads: JsonlV2Payload[] = [];
      const turnData: Array<{ turnKey: string; revision: number; contentHash: string }> = [];

      if (batch.resetReason) {
        payloads.push({
          v: 2,
          type: 'session_reset',
          txId: '', // filled after txId computed
          sessionId: batch.sessionId,
          historyEpoch,
          reason: batch.resetReason,
        });
      }

      for (const candidate of batch.candidates) {
        const storedHead = lockedWriter.getTurnHead(candidate.sessionId, candidate.turnKey);
        const head = storedHead?.historyEpoch === historyEpoch ? storedHead : undefined;
        const effectiveSourceOrder = head ? head.sourceOrder : candidate.sourceOrder;

        const effectiveCandidate = { ...candidate, sourceOrder: effectiveSourceOrder };
        const parts = buildCheckpointParts(effectiveCandidate);
        const toolResults = candidateToolResults(candidate);
        const contentHash = createContentHash(
          candidate.prompt,
          candidate.assistant,
          toolResults,
          parts,
          candidate.executions ?? [],
          candidate.runtime,
          candidate.projectPath
        );

        if (head) {
          if (head.contentHash === contentHash) {
            results.push({
              status: 'already_current',
              turnKey: candidate.turnKey,
              revision: head.revision,
            });
            continue;
          }

          const cmp = compareObservationBoundary(candidate.observedThrough, head.observedThrough);
          if (cmp === 'older') {
            results.push({
              status: 'stale',
              turnKey: candidate.turnKey,
              revision: head.revision,
            });
            continue;
          }
          if (cmp === 'incomparable') {
            results.push({
              status: 'conflict',
              turnKey: candidate.turnKey,
              revision: head.revision,
              reason: 'incomparable observation boundary kinds',
            });
            continue;
          }
        }

        const revision = head ? head.revision + 1 : 1;

        const checkpoint: TurnCheckpointV2 = {
          sessionId: candidate.sessionId,
          runtime: candidate.runtime,
          turnKey: candidate.turnKey,
          sourceOrder: effectiveSourceOrder,
          observedThrough: candidate.observedThrough,
          historyEpoch,
          revision,
          contentHash,
          completedAt: candidate.completedAt,
          projectPath: candidate.projectPath,
          parts,
          executions: candidate.executions ?? [],
        };

        checkpoints.push(checkpoint);
        turnData.push({ turnKey: checkpoint.turnKey, revision, contentHash });

        payloads.push({
          v: 2,
          type: 'turn_checkpoint',
          txId: '',
          ...checkpoint,
        });
      }

      if (payloads.length === 0) return null;
      if (payloads.length > MAX_PREPARED_PAYLOAD_RECORDS) {
        throw new Error(`Prepared receipt exceeds ${MAX_PREPARED_PAYLOAD_RECORDS} payload records`);
      }

      const txId = buildTxId(batch.sessionId, historyEpoch, !!batch.resetReason, turnData);

      // Assign txId to all payloads
      for (const p of payloads) {
        (p as { txId: string }).txId = txId;
      }

      const now = new Date();
      const targetPath = getJsonlFilePath(jsonlDir, now);
      const receiptWithoutLines: Omit<PreparedCheckpointV2, 'allLines' | 'payloadDigest'> = {
        version: 2,
        phase: 'prepared',
        txId,
        runtime: batch.runtime,
        sessionId: batch.sessionId,
        targetPath,
        turnKeys: turnData.map((t) => t.turnKey),
        finalization: batch.finalization,
      };
      assertPayloadsFitPreparedReceipt(payloads, receiptWithoutLines);
      const serialized = serializeV2Transaction(payloads, {
        txId,
        createdAt: now.toISOString(),
        targetPath,
      });

      // Write prepared receipt
      const receiptValue: PreparedCheckpointV2 = {
        ...receiptWithoutLines,
        payloadDigest: serialized.payloadDigest,
        allLines: serialized.allLines,
      };
      assertPreparedReceiptCanBeRecovered(receiptValue);
      const receiptPath = writePreparedCheckpoint(stateRoot, receiptValue);

      const { transaction } = lockedWriter.appendPrepared(serialized);
      lockedWriter.applyCommittedToIndex(transaction);

      updatePreparedPhase(receiptPath, 'jsonl_committed');

      for (const cp of checkpoints) {
        results.push({ status: 'inserted', turnKey: cp.turnKey, revision: cp.revision, txId });
      }

      return { receiptPath, checkpoints, isReset: !!batch.resetReason };
    });

    if (!committed) return results;

    // Apply to SQLite cache
    const db = getDatabase(config.database.path);
    initializeSchema(db);
    const store = new Store(db);

    try {
      if (committed.isReset) {
        store.replaceSessionWithBaseline(batch.sessionId, committed.checkpoints);
      } else {
        for (const cp of committed.checkpoints) {
          store.applyTurnCheckpoint(cp);
        }
      }
      updatePreparedPhase(committed.receiptPath, 'sqlite_applied');
    } finally {
      db.close();
    }

    // Finalize: remove pending, write cursor, mark finalized
    const allSuccess = results.every(
      (r) => r.status === 'inserted' || r.status === 'already_current'
    );

    if (allSuccess) {
      if (batch.finalization.cursorPath && batch.finalization.cursorAfter) {
        writeRuntimeCursor(
          stateRoot,
          batch.runtime,
          batch.sessionId,
          batch.finalization.cursorAfter
        );
      }
      for (const pendingPath of batch.finalization.pendingPaths) {
        removePendingPrompt(pendingPath);
        try {
          const dirFd = fs.openSync(path.dirname(pendingPath), 'r');
          try {
            fs.fsyncSync(dirFd);
          } finally {
            fs.closeSync(dirFd);
          }
        } catch {
          /* ignore */
        }
      }
      finalizePreparedCheckpoint(committed.receiptPath);
    }

    return results;
  } finally {
    txWriter.close();
  }
}

export async function recoverPreparedCheckpoints(
  config: EngramConfig,
  runtime?: HookRuntime
): Promise<{ finalized: number; superseded: number; failed: number }> {
  const stateRoot = getStateRoot(config);
  const preparedDir = path.join(stateRoot, 'prepared');
  const runtimes: HookRuntime[] = runtime ? [runtime] : ['claude', 'codex', 'kimi'];
  let finalized = 0;
  let superseded = 0;
  let failed = 0;

  if (!fs.existsSync(preparedDir)) return { finalized, superseded, failed };
  enforcePrivateDirectory(preparedDir);

  for (const rt of runtimes) {
    const dir = path.join(preparedDir, rt);
    if (!fs.existsSync(dir)) continue;
    enforcePrivateDirectory(dir);

    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dir, file.name);
      try {
        const receipt = parseRecoveryReceipt(filePath);
        if (receipt.runtime !== rt) {
          throw new Error('Prepared receipt runtime does not match its directory');
        }
        validateRecoveryPaths(receipt, config, stateRoot);
        if (receipt.phase === 'finalized' || receipt.phase === 'superseded') {
          fs.rmSync(filePath, { force: true });
          continue;
        }

        const jsonlDir = config.storage.jsonlDir;
        const txWriter = new JsonlTransactionWriter(jsonlDir);
        try {
          txWriter.withExclusiveTransaction((lockedWriter) => {
            if (lockedWriter.getSessionEpoch(receipt.sessionId) > receipt.historyEpoch) {
              markPreparedSuperseded(filePath, 'newer session epoch covers receipt');
              superseded++;
              return;
            }

            // Check if already committed
            if (
              lockedWriter.findCommitted(receipt.targetPath, receipt.txId, receipt.payloadDigest)
            ) {
              lockedWriter.applyCommittedToIndex({
                txId: receipt.txId,
                createdAt: new Date().toISOString(),
                filePath: receipt.targetPath,
                beginOffset: 0,
                endOffset: fs.lstatSync(receipt.targetPath).size,
                payloadDigest: receipt.payloadDigest,
                payloads: receipt.payloads,
              });
              // Already in JSONL — apply to SQLite and finalize
              const db = getDatabase(config.database.path);
              initializeSchema(db);
              const store = new Store(db);
              try {
                const checkpoints: TurnCheckpointV2[] = [];
                let containsReset = false;
                for (const record of receipt.payloads) {
                  if (record.v !== 2) continue;
                  if (record.type === 'session_reset') containsReset = true;
                  if (record.type === 'turn_checkpoint') checkpoints.push(record);
                }
                if (containsReset) {
                  store.replaceSessionWithBaseline(receipt.sessionId, checkpoints);
                } else {
                  for (const checkpoint of checkpoints) {
                    store.applyTurnCheckpoint(checkpoint);
                  }
                }
              } finally {
                db.close();
              }

              finalizePreparedCheckpoint(filePath);
              finalized++;
              return;
            }

            // Not committed — check if superseded by comparing head boundaries
            let allTurnsCovered = receipt.turnKeys.length > 0;
            for (const turnKey of receipt.turnKeys) {
              const head = lockedWriter.getTurnHead(receipt.sessionId, turnKey);
              if (!head) {
                allTurnsCovered = false;
                break;
              }
              // Find the receipt's checkpoint for this turn to compare boundaries
              const receiptCheckpoint = receipt.payloads.find(
                (record) => record.type === 'turn_checkpoint' && record.turnKey === turnKey
              );
              if (
                receiptCheckpoint?.type !== 'turn_checkpoint' ||
                !canonicalHeadCoversCheckpoint(head, receiptCheckpoint)
              ) {
                allTurnsCovered = false;
                break;
              }
            }

            if (allTurnsCovered) {
              markPreparedSuperseded(filePath, 'canonical head covers turns');
              superseded++;
              return;
            }

            markPreparedSuperseded(filePath, 'uncommitted receipt requires source replay');
            superseded++;
          });

          // If we got here and phase is jsonl_committed, apply to SQLite
          const updated = parseRecoveryReceipt(filePath);
          if (updated.phase === 'jsonl_committed') {
            const db = getDatabase(config.database.path);
            initializeSchema(db);
            const store = new Store(db);
            try {
              const checkpoints: TurnCheckpointV2[] = [];
              let containsReset = false;
              for (const record of updated.payloads) {
                if (record.v !== 2) continue;
                if (record.type === 'session_reset') containsReset = true;
                if (record.type === 'turn_checkpoint') checkpoints.push(record);
              }
              if (containsReset) {
                store.replaceSessionWithBaseline(updated.sessionId, checkpoints);
              } else {
                for (const checkpoint of checkpoints) store.applyTurnCheckpoint(checkpoint);
              }
            } finally {
              db.close();
            }
            finalizePreparedCheckpoint(filePath);
            finalized++;
          }
        } finally {
          txWriter.close();
        }
      } catch {
        failed++;
      }
    }
  }

  return { finalized, superseded, failed };
}
