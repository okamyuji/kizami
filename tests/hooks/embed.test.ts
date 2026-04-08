import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';
import type { Chunk } from '@/db/store';
import { backfillEmbeddings } from '@/hooks/embed';

// Mock the embedding module to avoid loading the actual model
vi.mock('@/search/embedding', () => ({
  getEmbedding: () => Promise.resolve(new Float32Array(256).fill(0.1)),
}));

describe('backfillEmbeddings', () => {
  let tmpDir: string;
  let dbPath: string;
  let configPath: string;

  function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
    return {
      sessionId: 'session-1',
      projectPath: '/test/project',
      chunkIndex: 0,
      content: 'Test chunk content about TypeScript development',
      role: 'mixed',
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: 10,
      ...overrides,
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-embed-'));
    dbPath = path.join(tmpDir, 'test.db');

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    store.insertChunks([
      makeChunk({ chunkIndex: 0, content: 'First chunk about React' }),
      makeChunk({ chunkIndex: 1, content: 'Second chunk about TypeScript' }),
      makeChunk({ chunkIndex: 2, content: 'Third chunk about testing' }),
    ]);
    db.close();

    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        database: { path: dbPath },
        search: { mode: 'hybrid' },
        embedding: { model: 'test-model', quantized: true, dimensions: 256 },
      })
    );

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should generate embeddings for all chunks', async () => {
    const result = await backfillEmbeddings({ configPath });

    expect(result.total).toBe(3);
    expect(result.processed).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it('should return zero when all chunks already have embeddings', async () => {
    // First run: generate all embeddings
    await backfillEmbeddings({ configPath });

    // Second run: nothing to do
    const result = await backfillEmbeddings({ configPath });
    expect(result.total).toBe(0);
    expect(result.processed).toBe(0);
  });

  it('should support dry-run mode', async () => {
    const result = await backfillEmbeddings({ configPath, dryRun: true });

    expect(result.total).toBe(3);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(3);

    // Verify no embeddings were actually created
    const db = getDatabase(dbPath);
    const store = new Store(db);
    const missing = store.getChunkIdsWithoutEmbedding();
    db.close();
    expect(missing.length).toBe(3);
  });

  it('should throw error when not in hybrid mode', async () => {
    const coreConfigPath = path.join(tmpDir, 'core-config.json');
    fs.writeFileSync(
      coreConfigPath,
      JSON.stringify({
        database: { path: dbPath },
        search: { mode: 'core' },
      })
    );

    await expect(backfillEmbeddings({ configPath: coreConfigPath })).rejects.toThrow('hybrid mode');
  });
});
