import { createHash } from 'node:crypto';
import { getJsonlFilePath } from '@/jsonl/path';
import { serializeV2Transaction } from '@/jsonl/transaction';
import { JsonlTransactionWriter } from '@/jsonl/writer';
import type { LockedJsonlWriter } from '@/jsonl/writer';
import type { JsonlV2Payload } from '@/jsonl/types';

function txIdFor(...fields: string[]): string {
  return createHash('sha256').update(fields.join('\0')).digest('hex');
}

/**
 * 削除を JSONL 正本に 1 トランザクションとして書く。rebuild や別ホストの同期でも
 * 削除が保たれるようにするため。正本が不整合なら何も書かずに失敗する。
 */
function appendDeletion(
  jsonlDir: string,
  build: (writer: LockedJsonlWriter) => { payload: JsonlV2Payload; txId: string }
): void {
  const txWriter = new JsonlTransactionWriter(jsonlDir);
  try {
    txWriter.withExclusiveTransaction((writer) => {
      const reconcile = writer.reconcileCanonicalIndex();
      // Stryker disable ConditionalExpression,BlockStatement,StringLiteral: reconcileCanonicalIndex は現在 常に ready を返すスタブ(writer.ts)で、この分岐には到達できない。commitCheckpointBatch と同じ手順に揃えておく
      if (reconcile.status !== 'ready') {
        throw new Error(
          `JSONL store is ${reconcile.status} (${reconcile.reason}); nothing was deleted.`
        );
      }
      // Stryker restore ConditionalExpression,BlockStatement,StringLiteral
      const { payload, txId } = build(writer);
      const now = new Date();
      const serialized = serializeV2Transaction([payload], {
        txId,
        createdAt: now.toISOString(),
        targetPath: getJsonlFilePath(jsonlDir, now),
      });
      const { transaction } = writer.appendPrepared(serialized);
      writer.applyCommittedToIndex(transaction);
    });
  } finally {
    txWriter.close();
  }
}

/** 中身の無い session_reset で表す。fold はそれより前の v1 と古い epoch のターンを捨てる。 */
export function appendSessionDeletion(jsonlDir: string, sessionId: string): void {
  appendDeletion(jsonlDir, (writer) => {
    const historyEpoch = writer.allocateSessionEpoch(sessionId);
    return {
      txId: txIdFor('session_delete', sessionId, String(historyEpoch)),
      payload: {
        v: 2,
        type: 'session_reset',
        // Stryker disable next-line StringLiteral: txId は serializeV2Transaction が上書きする
        txId: '',
        sessionId,
        historyEpoch,
        reason: 'deleted',
      },
    };
  });
}

export function appendChunkDeletion(jsonlDir: string, sessionId: string, externalId: string): void {
  appendDeletion(jsonlDir, () => ({
    txId: txIdFor('chunk_delete', sessionId, externalId),
    // Stryker disable next-line StringLiteral: txId は serializeV2Transaction が上書きする
    payload: { v: 2, type: 'chunk_delete', txId: '', sessionId, externalId },
  }));
}
