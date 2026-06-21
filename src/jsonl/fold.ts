import type { JsonlChunkRecord } from './types';
import type { TurnCheckpointV2 } from '@/checkpoint/types';
import { readJsonlFile } from './reader';
import { readCanonicalTransactions } from './reader';

export interface JsonlFoldError {
  code: 'invalid_transaction' | 'revision_conflict';
  filePath: string;
  txId?: string;
  message: string;
}

export interface CanonicalHistory {
  legacyChunks: JsonlChunkRecord[];
  turns: Map<string, TurnCheckpointV2>;
  resetSessions: Set<string>;
  errors: JsonlFoldError[];
}

function turnMapKey(sessionId: string, turnKey: string): string {
  const sLen = Buffer.byteLength(sessionId, 'utf-8');
  const tLen = Buffer.byteLength(turnKey, 'utf-8');
  return `${sLen}:${sessionId}${tLen}:${turnKey}`;
}

export async function foldCanonicalHistory(files: string[]): Promise<CanonicalHistory> {
  const legacyChunks: JsonlChunkRecord[] = [];
  const turns = new Map<string, TurnCheckpointV2>();
  const resetSessions = new Set<string>();
  const sessionMaxEpoch = new Map<string, number>();
  const errors: JsonlFoldError[] = [];

  for (const file of files) {
    for await (const record of readJsonlFile(file)) {
      legacyChunks.push(record);
    }

    for await (const result of readCanonicalTransactions(file)) {
      if (result.kind === 'diagnostic') {
        errors.push({
          code: 'invalid_transaction',
          filePath: result.filePath,
          txId: result.txId,
          message: result.message,
        });
        continue;
      }

      const { transaction } = result;

      for (const payload of transaction.payloads) {
        if (payload.type === 'session_reset') {
          resetSessions.add(payload.sessionId);
          const currentMax = sessionMaxEpoch.get(payload.sessionId) ?? 0;
          if (payload.historyEpoch > currentMax) {
            sessionMaxEpoch.set(payload.sessionId, payload.historyEpoch);
          }
          continue;
        }

        if (payload.type === 'turn_checkpoint') {
          const checkpoint: TurnCheckpointV2 = {
            sessionId: payload.sessionId,
            runtime: payload.runtime,
            turnKey: payload.turnKey,
            sourceOrder: payload.sourceOrder,
            observedThrough: payload.observedThrough,
            historyEpoch: payload.historyEpoch,
            revision: payload.revision,
            contentHash: payload.contentHash,
            completedAt: payload.completedAt,
            projectPath: payload.projectPath,
            parts: payload.parts,
          };

          const key = turnMapKey(checkpoint.sessionId, checkpoint.turnKey);
          const existing = turns.get(key);

          if (!existing) {
            turns.set(key, checkpoint);
            continue;
          }

          if (checkpoint.revision === existing.revision) {
            if (checkpoint.contentHash === existing.contentHash) {
              continue;
            }
            errors.push({
              code: 'revision_conflict',
              filePath: file,
              txId: transaction.txId,
              message: `revision ${checkpoint.revision} for turn ${checkpoint.turnKey} has different content hashes`,
            });
            continue;
          }

          if (checkpoint.revision > existing.revision) {
            turns.set(key, checkpoint);
          }
        }
      }
    }
  }

  // Remove legacy chunks for sessions that have a committed reset
  const filteredLegacy = legacyChunks.filter((c) => !resetSessions.has(c.sessionId));

  // Filter v2 checkpoints by epoch
  for (const [key, checkpoint] of turns) {
    if (resetSessions.has(checkpoint.sessionId)) {
      const maxEpoch = sessionMaxEpoch.get(checkpoint.sessionId) ?? 0;
      if (checkpoint.historyEpoch < maxEpoch) {
        turns.delete(key);
      }
    }
  }

  return { legacyChunks: filteredLegacy, turns, resetSessions, errors };
}

export async function rebuildCanonicalIndex(
  jsonlDir: string,
  files: string[],
  stateRoots: { pendingRoot: string; preparedRoot: string }
): Promise<{ filesProcessed: number; transactionsIndexed: number }> {
  void stateRoots;
  const history = await foldCanonicalHistory(files);

  if (history.errors.some((e) => e.code === 'revision_conflict')) {
    throw new Error(
      `Rebuild failed: revision conflicts found: ${history.errors
        .filter((e) => e.code === 'revision_conflict')
        .map((e) => e.message)
        .join('; ')}`
    );
  }

  return {
    filesProcessed: files.length,
    transactionsIndexed: history.turns.size,
  };
}
