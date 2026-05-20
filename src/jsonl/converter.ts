import type { Chunk } from '@/db/store';
import type { JsonlChunkRecord } from '@/jsonl/types';
import { float32ToHex } from '@/jsonl/codec';
import { randomUUID } from 'node:crypto';

/**
 * Chunk[] + 任意のembedding配列 → JsonlChunkRecord[] への変換。
 * externalId が未設定の場合は crypto.randomUUID() を割り当てる。
 *
 * 副作用: chunk.externalId / chunk.createdAt を mutate する（呼び出し側がそのまま
 * SQLite 挿入に再利用できるようにするため）。
 */
export function chunksToJsonlRecords(
  chunks: Chunk[],
  embeddings?: Map<number, { vec: Float32Array; model: string }>
): JsonlChunkRecord[] {
  const now = new Date().toISOString();
  return chunks.map((c, idx) => {
    if (!c.externalId) c.externalId = randomUUID();
    if (!c.createdAt) c.createdAt = now;
    const emb = embeddings?.get(idx);
    const record: JsonlChunkRecord = {
      v: 1,
      type: 'chunk',
      id: c.externalId,
      sessionId: c.sessionId,
      projectPath: c.projectPath,
      chunkIndex: c.chunkIndex,
      content: c.content,
      role: c.role,
      metadata: JSON.stringify(c.metadata),
      tokenCount: c.tokenCount,
      createdAt: c.createdAt,
    };
    if (emb) {
      record.embedding = float32ToHex(emb.vec);
      record.embeddingDim = emb.vec.length;
      record.embeddingModel = emb.model;
    }
    return record;
  });
}

export function jsonlRecordToChunk(rec: JsonlChunkRecord): Chunk {
  let metadata: Chunk['metadata'];
  try {
    metadata = JSON.parse(rec.metadata ?? 'null') as Chunk['metadata'];
    if (!metadata) {
      metadata = { filePaths: [], toolNames: [], errorMessages: [] };
    }
  } catch {
    metadata = { filePaths: [], toolNames: [], errorMessages: [] };
  }
  return {
    externalId: rec.id,
    sessionId: rec.sessionId,
    projectPath: rec.projectPath,
    chunkIndex: rec.chunkIndex,
    content: rec.content,
    role: rec.role,
    metadata,
    createdAt: rec.createdAt,
    tokenCount: rec.tokenCount,
  };
}
