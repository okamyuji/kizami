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
  writePreparedCheckpoint,
  updatePreparedPhase,
  removePendingPrompt,
  writeRuntimeCursor,
  finalizePreparedCheckpoint,
  markPreparedSuperseded,
} from './state';
import { buildCheckpointParts } from './builder';
import { hashFields, createContentHash, compareObservationBoundary } from './identity';
import { serializeV2Transaction } from '@/jsonl/transaction';
import { JsonlTransactionWriter } from '@/jsonl/writer';
import type { JsonlV2Payload, SerializedJsonlTransaction } from '@/jsonl/types';
import { getJsonlFilePath } from '@/jsonl/path';
import { Store } from '@/db/store';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CheckpointBatch {
  runtime: HookRuntime;
  sessionId: string;
  candidates: TurnCheckpointCandidate[];
  resetReason?: 'legacy_mismatch';
  finalization: AdapterExtraction['finalization'];
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
        // Reuse existing sourceOrder from head if available
        const head = lockedWriter.getTurnHead(candidate.sessionId, candidate.turnKey);
        if (head) {
          candidate.sourceOrder = head.sourceOrder;
        }

        const parts = buildCheckpointParts(candidate);
        const toolResults = candidateToolResults(candidate);
        const contentHash = createContentHash(
          candidate.prompt,
          candidate.assistant,
          toolResults,
          parts
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
          sourceOrder: candidate.sourceOrder,
          observedThrough: candidate.observedThrough,
          historyEpoch,
          revision,
          contentHash,
          completedAt: candidate.completedAt,
          projectPath: candidate.projectPath,
          parts,
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

      const txId = buildTxId(batch.sessionId, historyEpoch, !!batch.resetReason, turnData);

      // Assign txId to all payloads
      for (const p of payloads) {
        (p as { txId: string }).txId = txId;
      }

      const now = new Date();
      const targetPath = getJsonlFilePath(jsonlDir, now);
      const serialized = serializeV2Transaction(payloads, {
        txId,
        createdAt: now.toISOString(),
        targetPath,
      });

      // Write prepared receipt
      const receiptValue: PreparedCheckpointV2 = {
        version: 2,
        phase: 'prepared',
        txId,
        runtime: batch.runtime,
        sessionId: batch.sessionId,
        targetPath,
        payloadDigest: serialized.payloadDigest,
        allLines: serialized.allLines,
        records: serialized.records,
        turnKeys: turnData.map((t) => t.turnKey),
        finalization: batch.finalization,
      };
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
      (r) => r.status === 'inserted' || r.status === 'already_current' || r.status === 'stale'
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

  for (const rt of runtimes) {
    const dir = path.join(preparedDir, rt);
    if (!fs.existsSync(dir)) continue;

    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dir, file.name);
      try {
        const receipt = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PreparedCheckpointV2;
        if (receipt.phase === 'finalized' || receipt.phase === 'superseded') {
          fs.rmSync(filePath, { force: true });
          continue;
        }

        const jsonlDir = config.storage.jsonlDir;
        const txWriter = new JsonlTransactionWriter(jsonlDir);
        try {
          txWriter.withExclusiveTransaction((lockedWriter) => {
            // Check if already committed
            if (
              lockedWriter.findCommitted(receipt.targetPath, receipt.txId, receipt.payloadDigest)
            ) {
              // Already in JSONL — apply to SQLite and finalize
              const db = getDatabase(config.database.path);
              initializeSchema(db);
              const store = new Store(db);
              try {
                for (const record of receipt.records) {
                  if ('v' in record && record.v === 2 && record.type === 'turn_checkpoint') {
                    store.applyTurnCheckpoint(record);
                  }
                }
              } finally {
                db.close();
              }

              finalizePreparedCheckpoint(filePath);
              finalized++;
              return;
            }

            // Not committed — check if superseded
            let isSuperseded = false;
            for (const turnKey of receipt.turnKeys) {
              const head = lockedWriter.getTurnHead(receipt.sessionId, turnKey);
              if (head) {
                // Check if head covers this receipt's turns
                isSuperseded = true;
              }
            }

            if (isSuperseded) {
              markPreparedSuperseded(filePath, 'canonical head covers turns');
              for (const pendingPath of receipt.finalization.pendingPaths) {
                removePendingPrompt(pendingPath);
              }
              superseded++;
              return;
            }

            // Reconstruct and append
            const serialized: SerializedJsonlTransaction = {
              txId: receipt.txId,
              createdAt: new Date().toISOString(),
              targetPath: receipt.targetPath,
              payloadLines: receipt.allLines.slice(1, -1),
              payloadDigest: receipt.payloadDigest,
              allLines: receipt.allLines,
              records: receipt.records,
            };

            const { transaction } = lockedWriter.appendPrepared(serialized);
            lockedWriter.applyCommittedToIndex(transaction);
            updatePreparedPhase(filePath, 'jsonl_committed');
          });

          // If we got here and phase is jsonl_committed, apply to SQLite
          const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PreparedCheckpointV2;
          if (updated.phase === 'jsonl_committed') {
            const db = getDatabase(config.database.path);
            initializeSchema(db);
            const store = new Store(db);
            try {
              for (const record of receipt.records) {
                if ('v' in record && record.v === 2 && record.type === 'turn_checkpoint') {
                  store.applyTurnCheckpoint(record);
                }
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
