import type { EngramConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema, initializeHybridSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { listJsonlFiles, ensureJsonlDir } from '@/jsonl/path';
import { hexToFloat32 } from '@/jsonl/codec';
import { foldCanonicalHistory } from '@/jsonl/fold';
import type { JsonlChunkRecord } from '@/jsonl/types';

export interface RebuildResult {
  filesProcessed: number;
  chunksInserted: number;
  embeddingsRestored: number;
  durationMs: number;
  dryRun: boolean;
}

export interface RebuildOptions {
  dryRun?: boolean;
  fromMonth?: string;
}

/**
 * JSONL 正本から SQLite キャッシュを完全再構築する。
 * - SQLite テーブルを truncate してから JSONL を逐次読み込み
 * - embedding 列が JSONL に含まれていれば、hex デコードして chunks_vec を復元
 *   （モデルを再ロードせずに復元できることが「顕著改善」の柱）
 * - dryRun 時は SQLite に書き込まずに件数のみ返す
 */
export async function rebuildFromJsonl(
  config: EngramConfig,
  options: RebuildOptions = {}
): Promise<RebuildResult> {
  if (options.fromMonth && !options.dryRun) {
    throw new Error('--from-month is only supported with --dry-run');
  }
  const startedAt = Date.now();
  let embeddingsRestored = 0;
  ensureJsonlDir(config.storage.jsonlDir);
  const allFiles = listJsonlFiles(config.storage.jsonlDir);
  const files = options.fromMonth
    ? allFiles.filter((file) => file.includes(options.fromMonth!))
    : allFiles;
  const history = await foldCanonicalHistory(files);
  if (history.errors.length > 0) {
    throw new Error(
      `Rebuild validation failed: ${history.errors.map((error) => error.message).join('; ')}`
    );
  }

  const chunksInserted =
    history.legacyChunks.length +
    [...history.turns.values()].reduce((count, checkpoint) => count + checkpoint.parts.length, 0);

  if (!options.dryRun) {
    const db = getDatabase(config.database.path);
    try {
      initializeSchema(db);
      let hybridReady = false;
      try {
        initializeHybridSchema(db, config.embedding.dimensions);
        hybridReady = config.search.mode === 'hybrid';
      } catch {
        hybridReady = false;
      }
      const embeddings: Array<{ externalId: string; vector: Float32Array }> = [];
      if (hybridReady) {
        for (const record of history.legacyChunks) {
          if (!record.embedding || !record.embeddingDim) continue;
          const vector = hexToFloat32(record.embedding);
          if (vector.length !== record.embeddingDim) {
            throw new Error(`Invalid embedding dimension for ${record.id}`);
          }
          embeddings.push({ externalId: record.id, vector });
        }
      }
      const store = new Store(db);
      store.materializeCanonicalHistory(history, embeddings);
      embeddingsRestored = embeddings.length;
    } finally {
      db.close();
    }
  }

  return {
    filesProcessed: files.length,
    chunksInserted,
    embeddingsRestored,
    durationMs: Date.now() - startedAt,
    dryRun: options.dryRun === true,
  };
}

export function _unusedJsonlChunkRecord(): JsonlChunkRecord | undefined {
  // type re-export usage stub: avoid TS unused-import warnings when consumer
  // imports for typing only.
  return undefined;
}
