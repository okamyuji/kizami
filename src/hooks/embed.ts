import { loadConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema, initializeHybridSchema } from '@/db/schema';
import { Store } from '@/db/store';

export interface BackfillResult {
  total: number;
  processed: number;
  skipped: number;
}

export async function backfillEmbeddings(options?: {
  configPath?: string;
  dryRun?: boolean;
}): Promise<BackfillResult> {
  const config = loadConfig(options?.configPath);

  if (config.search.mode !== 'hybrid') {
    throw new Error(
      'Embedding backfill requires hybrid mode. Set search.mode to "hybrid" in config.json.'
    );
  }

  const db = getDatabase(config.database.path);
  initializeSchema(db);

  try {
    initializeHybridSchema(db, config.embedding.dimensions);
    const store = new Store(db);
    const missingIds = store.getChunkIdsWithoutEmbedding();

    if (missingIds.length === 0) {
      return { total: 0, processed: 0, skipped: 0 };
    }

    if (options?.dryRun) {
      return { total: missingIds.length, processed: 0, skipped: missingIds.length };
    }

    const { getEmbedding } = await import('@/search/embedding');
    const docPrefix = '検索文書: ';
    let processed = 0;
    let skipped = 0;

    for (const id of missingIds) {
      const chunk = store.getChunk(id);
      if (!chunk) {
        skipped++;
        continue;
      }

      const emb = await getEmbedding(docPrefix + chunk.content.slice(0, 512), config);
      store.insertEmbedding(id, emb);
      processed++;

      if (processed % 100 === 0) {
        process.stderr.write(`\r  Processed: ${processed}/${missingIds.length}`);
      }
    }

    if (processed >= 100) {
      process.stderr.write('\n');
    }

    return { total: missingIds.length, processed, skipped };
  } finally {
    db.close();
  }
}
