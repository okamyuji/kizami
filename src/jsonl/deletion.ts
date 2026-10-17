import { createHash } from 'node:crypto';
import { getJsonlFilePath, listJsonlFiles } from '@/jsonl/path';
import { readJsonlLines } from '@/jsonl/reader';
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
  build: (writer: LockedJsonlWriter) => { payloads: JsonlV2Payload[]; txId: string }
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
      const { payloads, txId } = build(writer);
      const now = new Date();
      const serialized = serializeV2Transaction(payloads, {
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
      payloads: [
        {
          v: 2,
          type: 'session_reset',
          // Stryker disable next-line StringLiteral: txId は serializeV2Transaction が上書きする
          txId: '',
          sessionId,
          historyEpoch,
          reason: 'deleted',
        },
      ],
    };
  });
}

export function appendChunkDeletion(jsonlDir: string, sessionId: string, externalId: string): void {
  appendChunkDeletions(jsonlDir, [{ sessionId, externalId }]);
}

/** 複数のチャンクの削除を、1 トランザクションとして書く。 */
export function appendChunkDeletions(
  jsonlDir: string,
  deletions: Array<{ sessionId: string; externalId: string }>
): void {
  appendDeletion(jsonlDir, () => ({
    txId: txIdFor('chunk_delete', ...deletions.flatMap((d) => [d.sessionId, d.externalId])),
    payloads: deletions.map(({ sessionId, externalId }) => ({
      v: 2 as const,
      type: 'chunk_delete' as const,
      // Stryker disable next-line StringLiteral: txId は serializeV2Transaction が上書きする
      txId: '',
      sessionId,
      externalId,
    })),
  }));
}

/** 正本の記録のうち、本文が text で始まるもの。手で消した部品も含む。 */
export interface StartingRecords {
  /** turn_checkpoint の先頭の part。キーは sessionId, turnKey, historyEpoch, revision。 */
  turns: Set<string>;
  /** v1 の行。 */
  chunks: Array<{ id: string; sessionId: string; chunkIndex: number }>;
}

export const turnRecordKey = (t: {
  sessionId: string;
  turnKey: string;
  historyEpoch: number;
  revision: number;
}) => JSON.stringify([t.sessionId, t.turnKey, t.historyEpoch, t.revision]);

/**
 * 正本で削除されたチャンクの ID とそのセッション、本文に text を含む記録を持つセッション、
 * 本文が text で始まる記録を集める。
 */
export async function scanSessions(
  jsonlDir: string,
  text: string
): Promise<{
  deletedIds: Set<string>;
  deletedSessions: Set<string>;
  containing: Set<string>;
  starting: StartingRecords;
}> {
  const deletedIds = new Set<string>();
  const deletedSessions = new Set<string>();
  const containing = new Set<string>();
  const starting: StartingRecords = { turns: new Set(), chunks: [] };
  for (const file of listJsonlFiles(jsonlDir)) {
    for await (const result of readJsonlLines(file)) {
      if (result.kind !== 'record') continue;
      const record = result.record;
      if (record.type === 'chunk_delete') {
        deletedIds.add(record.externalId);
        deletedSessions.add(record.sessionId);
      } else if (record.type === 'chunk' && record.content.includes(text)) {
        containing.add(record.sessionId);
        if (record.content.startsWith(text)) starting.chunks.push(record);
      } else if (
        record.type === 'turn_checkpoint' &&
        record.parts.some((p) => p.content.includes(text))
      ) {
        containing.add(record.sessionId);
        if (record.parts.some((p) => p.partIndex === 0 && p.content.startsWith(text))) {
          starting.turns.add(turnRecordKey(record));
        }
      }
    }
  }
  return { deletedIds, deletedSessions, containing, starting };
}
