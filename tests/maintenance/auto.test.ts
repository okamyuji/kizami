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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-auto-test-'));
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

  it('prunes old execution evidence even when the session still has a recent chunk', () => {
    store.applyTurnCheckpoint({
      sessionId: 's-evidence',
      runtime: 'claude',
      turnKey: 'old-failure',
      sourceOrder: '00000000000000000001',
      observedThrough: { kind: 'source_offset', generation: 0, offset: 1 },
      historyEpoch: 0,
      revision: 1,
      contentHash: 'old-content',
      completedAt: '2020-01-01T00:00:00.000Z',
      projectPath: '/test',
      parts: [
        {
          partIndex: 0,
          externalId: 'old-part',
          content: 'old',
          role: 'assistant',
          metadata: { filePaths: [], toolNames: ['Bash'], errorMessages: [] },
          tokenCount: 1,
        },
      ],
      executions: [
        {
          executionIndex: 0,
          toolName: 'Bash',
          command: 'pnpm test',
          status: 'failed',
          outputExcerpt: 'failed',
        },
      ],
    });
    store.applyTurnCheckpoint({
      sessionId: 's-evidence',
      runtime: 'claude',
      turnKey: 'recent-success',
      sourceOrder: '00000000000000000002',
      observedThrough: { kind: 'source_offset', generation: 0, offset: 2 },
      historyEpoch: 0,
      revision: 1,
      contentHash: 'recent-content',
      completedAt: new Date().toISOString(),
      projectPath: '/test',
      parts: [
        {
          partIndex: 0,
          externalId: 'recent-part',
          content: 'recent',
          role: 'assistant',
          metadata: { filePaths: [], toolNames: ['Bash'], errorMessages: [] },
          tokenCount: 1,
        },
      ],
      executions: [
        {
          executionIndex: 0,
          toolName: 'Bash',
          command: 'pnpm test',
          status: 'succeeded',
          outputExcerpt: 'passed',
        },
      ],
    });
    expect(store.getStats().verifiedErrorResolutions).toBe(1);

    runAutoMaintenance(store, makeConfig({ maxChunkAgeDays: 90, maxDbSizeMB: 1000 }));

    expect(store.getExecutionObservations('s-evidence')).toHaveLength(1);
    expect(store.getExecutionObservations('s-evidence')[0].status).toBe('succeeded');
    expect(store.getStats().verifiedErrorResolutions).toBe(0);
  });

  it('deletes execution evidence when it is the only data exceeding the size limit', () => {
    db.prepare(
      `INSERT INTO execution_observations (
         runtime, session_id, project_path, turn_key, source_order, history_epoch, revision,
         execution_index, tool_name, command, status, output_excerpt, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'claude',
      'evidence-only',
      '/test',
      'turn-1',
      '00000000000000000001',
      0,
      1,
      0,
      'Bash',
      'pnpm test',
      'failed',
      'x'.repeat(100_000),
      '2020-01-01T00:00:00.000Z'
    );

    runAutoMaintenance(
      store,
      makeConfig({ maxChunkAgeDays: 9999, maxDbSizeMB: 0.001, intervalHours: 0 })
    );

    expect(store.getStats().explicitExecutionObservations).toBe(0);
  });

  it('recomputes resolutions after deleting the oldest execution observation', () => {
    const insert = db.prepare(
      `INSERT INTO execution_observations (
         runtime, session_id, project_path, turn_key, source_order, history_epoch, revision,
         execution_index, tool_name, command, status, output_excerpt, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      'claude',
      'prune-resolution',
      '/test',
      'failure',
      '00000000000000000001',
      0,
      1,
      0,
      'Bash',
      'pnpm test',
      'failed',
      'failed',
      '2020-01-01T00:00:00.000Z'
    );
    insert.run(
      'claude',
      'prune-resolution',
      '/test',
      'success',
      '00000000000000000002',
      0,
      1,
      0,
      'Bash',
      'pnpm test',
      'succeeded',
      'passed',
      '2020-01-02T00:00:00.000Z'
    );
    db.prepare(
      `INSERT INTO verified_error_resolutions (
         runtime, project_path, session_id, command,
         first_failure_turn_key, first_failure_execution_index,
         last_failure_turn_key, last_failure_execution_index, failure_count,
         failure_output_excerpt, success_turn_key, success_execution_index,
         success_output_excerpt, verified_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'claude',
      '/test',
      'prune-resolution',
      'pnpm test',
      'failure',
      0,
      'failure',
      0,
      1,
      'failed',
      'success',
      0,
      'passed',
      '2020-01-02T00:00:00.000Z'
    );

    expect(store.deleteOldestExecutionObservations(1)).toBe(1);

    expect(store.searchVerifiedResolutions(undefined, '/test')).toEqual([]);
    expect(store.getExecutionObservations('prune-resolution')).toMatchObject([
      { turnKey: 'success', status: 'succeeded' },
    ]);
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
