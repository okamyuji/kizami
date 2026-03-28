import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';
import { Store } from '../../src/db/store';
import type { Chunk } from '../../src/db/store';
import { runAutoMaintenance } from '../../src/maintenance/auto';
import { getDefaultConfig, type EngramConfig } from '../../src/config';
import type Database from 'better-sqlite3';

function makeChunk(sessionId: string, index: number, projectPath: string, content: string): Chunk {
  return {
    sessionId,
    projectPath,
    chunkIndex: index,
    content,
    role: 'mixed',
    metadata: { filePaths: [], toolNames: [], errorMessages: [] },
    tokenCount: Math.ceil(content.length / 4),
  };
}

function makeConfig(overrides: Partial<EngramConfig['maintenance']> = {}): EngramConfig {
  const config = getDefaultConfig();
  config.maintenance = { ...config.maintenance, ...overrides };
  return config;
}

describe('runAutoMaintenance', () => {
  let db: Database.Database;
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-auto-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = getDatabase(dbPath);
    initializeSchema(db);
    store = new Store(db);
  });

  afterEach(() => {
    db.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + '-wal');
      fs.unlinkSync(dbPath + '-shm');
    } catch {
      // ignore
    }
  });

  it('should skip when disabled', () => {
    const config = makeConfig({ enabled: false });
    const result = runAutoMaintenance(store, config);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('disabled');
  });

  it('should run on first execution (no previous log)', () => {
    store.insertChunks([makeChunk('s1', 0, '/test', 'hello world content')]);
    const config = makeConfig({ maxChunkAgeDays: 0 });
    const result = runAutoMaintenance(store, config);
    expect(result.skipped).toBe(false);
    expect(result.chunksDeleted).toBeGreaterThanOrEqual(0);
  });

  it('should skip if interval has not elapsed', () => {
    const config = makeConfig({ intervalHours: 24 });
    // Run once to create a log entry
    runAutoMaintenance(store, config);
    // Run again immediately — should skip
    const result = runAutoMaintenance(store, config);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('interval');
  });

  it('should delete old chunks based on maxChunkAgeDays', () => {
    // Insert chunk with old date
    store.insertChunks([makeChunk('s1', 0, '/test', 'old content')]);
    db.prepare(
      "UPDATE chunks SET created_at = datetime('now', '-100 days') WHERE session_id = 's1'"
    ).run();

    // Insert chunk with recent date
    store.insertChunks([makeChunk('s2', 0, '/test', 'new content')]);

    const config = makeConfig({ maxChunkAgeDays: 90 });
    const result = runAutoMaintenance(store, config);

    expect(result.skipped).toBe(false);
    expect(result.chunksDeleted).toBe(1);
    expect(store.getStats().totalChunks).toBe(1);
  });

  it('should delete orphaned sessions after chunk deletion', () => {
    store.insertChunks([makeChunk('s-orphan', 0, '/test', 'will be deleted')]);
    store.insertSession({
      sessionId: 's-orphan',
      projectPath: '/test',
      chunkCount: 1,
    });
    db.prepare(
      "UPDATE chunks SET created_at = datetime('now', '-200 days') WHERE session_id = 's-orphan'"
    ).run();

    const config = makeConfig({ maxChunkAgeDays: 90 });
    const result = runAutoMaintenance(store, config);

    expect(result.chunksDeleted).toBe(1);
    expect(result.orphanedSessionsDeleted).toBe(1);
    expect(store.getSessionList().length).toBe(0);
  });

  it('should log maintenance execution', () => {
    store.insertChunks([makeChunk('s1', 0, '/test', 'test content')]);
    const config = makeConfig({ maxChunkAgeDays: 0 });
    runAutoMaintenance(store, config);

    const lastRun = store.getLastMaintenanceTime();
    expect(lastRun).not.toBeNull();
  });

  it('should delete by size limit when DB exceeds maxDbSizeMB', () => {
    // Insert many chunks to grow the DB
    const chunks: Chunk[] = [];
    for (let i = 0; i < 200; i++) {
      chunks.push(makeChunk(`s-big-${i}`, 0, '/test', 'x'.repeat(2000)));
    }
    store.insertChunks(chunks);

    // VACUUM so page_count reflects actual data size
    store.vacuum();
    const countBefore = store.getStats().totalChunks;
    // Set max size to very small to force deletion
    const config = makeConfig({ maxChunkAgeDays: 9999, maxDbSizeMB: 0.001 });
    const result = runAutoMaintenance(store, config);

    expect(result.skipped).toBe(false);
    expect(result.chunksDeleted).toBeGreaterThan(0);
    expect(store.getStats().totalChunks).toBeLessThan(countBefore);
  });

  it('should not delete chunks that are within age limit', () => {
    store.insertChunks([makeChunk('s-recent', 0, '/test', 'recent content')]);

    const config = makeConfig({ maxChunkAgeDays: 90, maxDbSizeMB: 1000 });
    const result = runAutoMaintenance(store, config);

    expect(result.chunksDeleted).toBe(0);
    expect(store.getStats().totalChunks).toBe(1);
  });
});
