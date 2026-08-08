import type { JsonlChunkRecord } from './types';
import type { TurnCheckpointV2 } from '@/checkpoint/types';
import { readJsonlFile } from './reader';
import { readCanonicalTransactions } from './reader';

export interface JsonlFoldError {
  code: 'invalid_transaction' | 'revision_conflict';
  filePath: string;
  txId?: string;
  payloadDigest?: string;
  message: string;
  sessionId?: string;
  historyEpoch?: number;
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
  const turnsByEpoch = new Map<string, TurnCheckpointV2>();
  const resetSessions = new Set<string>();
  const sessionMaxEpoch = new Map<string, number>();
  const errors: JsonlFoldError[] = [];
  const committedPayloadDigests = new Map<string, Set<string>>();

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
          payloadDigest: result.payloadDigest,
          message: result.message,
        });
        continue;
      }

      const { transaction } = result;
      const digests = committedPayloadDigests.get(transaction.txId) ?? new Set<string>();
      if (digests.size > 0 && !digests.has(transaction.payloadDigest)) {
        errors.push({
          code: 'invalid_transaction',
          filePath: transaction.filePath,
          txId: transaction.txId,
          payloadDigest: transaction.payloadDigest,
          message: 'duplicate transaction ID has a different payload digest',
        });
        continue;
      }
      digests.add(transaction.payloadDigest);
      committedPayloadDigests.set(transaction.txId, digests);

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
            executions: payload.executions ?? [],
          };

          const key = `${turnMapKey(checkpoint.sessionId, checkpoint.turnKey)}:${checkpoint.historyEpoch}`;
          const existing = turnsByEpoch.get(key);

          if (!existing) {
            turnsByEpoch.set(key, checkpoint);
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
              sessionId: checkpoint.sessionId,
              historyEpoch: checkpoint.historyEpoch,
            });
            continue;
          }

          if (checkpoint.revision > existing.revision) {
            turnsByEpoch.set(key, checkpoint);
          }
        }
      }
    }
  }

  // Remove legacy chunks for sessions that have a committed reset
  const filteredLegacy = legacyChunks.filter((c) => !resetSessions.has(c.sessionId));

  // Select the maximum epoch first, then the maximum revision already chosen above.
  for (const checkpoint of turnsByEpoch.values()) {
    const maxEpoch = sessionMaxEpoch.get(checkpoint.sessionId) ?? checkpoint.historyEpoch;
    if (resetSessions.has(checkpoint.sessionId) && checkpoint.historyEpoch !== maxEpoch) continue;
    turns.set(turnMapKey(checkpoint.sessionId, checkpoint.turnKey), checkpoint);
  }

  const relevantErrors = errors.filter((error) => {
    if (error.code === 'invalid_transaction') {
      if (error.message === 'incomplete transaction at EOF') return false;
      if (
        error.message.startsWith('abandoned frame:') &&
        error.txId !== undefined &&
        error.payloadDigest !== undefined &&
        committedPayloadDigests.get(error.txId)?.has(error.payloadDigest) === true
      ) {
        return false;
      }
      return true;
    }
    return (
      error.sessionId === undefined ||
      !resetSessions.has(error.sessionId) ||
      error.historyEpoch === sessionMaxEpoch.get(error.sessionId)
    );
  });

  return { legacyChunks: filteredLegacy, turns, resetSessions, errors: relevantErrors };
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
