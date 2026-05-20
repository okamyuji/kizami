import type { EngramConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema, initializeHybridSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { listJsonlFiles, ensureJsonlDir } from '@/jsonl/path';
import { readJsonlFile } from '@/jsonl/reader';
import { hexToFloat32 } from '@/jsonl/codec';
import { jsonlRecordToChunk } from '@/jsonl/converter';
import type { Chunk } from '@/db/store';
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
  const startedAt = Date.now();
  const db = getDatabase(config.database.path);
  let chunksInserted = 0;
  let embeddingsRestored = 0;
  let filesProcessed = 0;

  try {
    initializeSchema(db);
    const store = new Store(db);

    ensureJsonlDir(config.storage.jsonlDir);
    const allFiles = listJsonlFiles(config.storage.jsonlDir);
    const files = options.fromMonth
      ? allFiles.filter((f) => f.includes(options.fromMonth!))
      : allFiles;

    if (!options.dryRun) {
      store.truncateAll();
    }

    // hybrid モードかつ embedding が JSONL に含まれていれば仮想テーブルを準備
    let hybridReady = false;
    if (config.search.mode === 'hybrid' && !options.dryRun) {
      try {
        initializeHybridSchema(db, config.embedding.dimensions);
        hybridReady = true;
      } catch {
        hybridReady = false;
      }
    }

    // sessions を chunks から後で再構築するための集計
    const sessionAgg = new Map<
      string,
      { projectPath: string; startedAt: string; endedAt: string; count: number }
    >();

    for (const file of files) {
      filesProcessed++;
      // 月ファイル単位でバッチINSERT（メモリ効率と性能のバランス）
      const batchChunks: Chunk[] = [];
      const batchEmbeddings: { externalId: string; vec: Float32Array }[] = [];

      for await (const rec of readJsonlFile(file)) {
        const chunk = jsonlRecordToChunk(rec);
        batchChunks.push(chunk);

        if (rec.embedding && rec.embeddingDim && hybridReady) {
          const vec = hexToFloat32(rec.embedding);
          if (vec.length === rec.embeddingDim) {
            batchEmbeddings.push({ externalId: rec.id, vec });
          }
        }

        // sessions 集計
        const existing = sessionAgg.get(rec.sessionId);
        if (existing) {
          existing.endedAt = rec.createdAt;
          existing.count++;
        } else {
          sessionAgg.set(rec.sessionId, {
            projectPath: rec.projectPath,
            startedAt: rec.createdAt,
            endedAt: rec.createdAt,
            count: 1,
          });
        }
        chunksInserted++;
      }

      if (!options.dryRun && batchChunks.length > 0) {
        // rebuild は複数月ファイルにまたがるため、insertChunks の
        // "同一セッションを総入れ替え" 動作だと月ファイル境界で前月分が消える。
        // 全件 append-only で挿入し、external_id の UNIQUE 制約で重複は弾く。
        store.appendChunksWithoutReplace(batchChunks);
        for (const { externalId, vec } of batchEmbeddings) {
          const id = store.getChunkIdByExternalId(externalId);
          if (id !== undefined) {
            store.insertEmbedding(id, vec);
            embeddingsRestored++;
          }
        }
      }
    }

    if (!options.dryRun) {
      for (const [sessionId, agg] of sessionAgg) {
        store.insertSession({
          sessionId,
          projectPath: agg.projectPath,
          startedAt: agg.startedAt,
          endedAt: agg.endedAt,
          chunkCount: agg.count,
        });
      }
    }
  } finally {
    db.close();
  }

  return {
    filesProcessed,
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
