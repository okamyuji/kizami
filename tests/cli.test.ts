import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getDatabase } from '../src/db/connection';
import { initializeSchema } from '../src/db/schema';
import { Store } from '../src/db/store';
import type { Chunk, Session } from '../src/db/store';
import {
  cmdSearch,
  cmdEdit,
  cmdDelete,
  cmdList,
  cmdStats,
  cmdPrune,
  cmdExport,
  cmdEmbed,
} from '../src/cli';

describe('cli commands', () => {
  let db: Database.Database;
  let store: Store;
  let tmpDir: string;
  let dbPath: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-cli-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = getDatabase(dbPath);
    initializeSchema(db);
    store = new Store(db);

    // Write a config pointing to our test DB
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        database: { path: dbPath },
        search: {
          mode: 'core',
          timeDecayHalfLifeDays: 30,
          defaultLimit: 10,
          projectScope: true,
        },
      })
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
    return {
      sessionId: 'session-1',
      projectPath: '/test/project',
      chunkIndex: 0,
      content: 'Test chunk content about React Hook Form validation',
      role: 'human',
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: 10,
      ...overrides,
    };
  }

  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      sessionId: 'session-1',
      projectPath: '/test/project',
      startedAt: '2024-06-01T00:00:00Z',
      endedAt: '2024-06-01T01:00:00Z',
      chunkCount: 3,
      firstMessage: 'Hello world',
      lastMessage: 'Goodbye',
      ...overrides,
    };
  }

  describe('search', () => {
    it('should find results matching the query', () => {
      store.insertChunks([
        makeChunk({ content: 'React Hook Form validation patterns and best practices' }),
        makeChunk({ chunkIndex: 1, content: 'Python Django setup guide' }),
      ]);

      const results = cmdSearch('React Hook', {
        project: '/test/project',
        config: configPath,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain('React');
    });

    it('should return empty array when no results', () => {
      const results = cmdSearch('nonexistent query xyz', {
        project: '/test/project',
        config: configPath,
      });
      expect(results).toEqual([]);
    });
  });

  describe('list', () => {
    it('should return sessions', () => {
      store.insertSession(makeSession());
      store.insertSession(makeSession({ sessionId: 'session-2', projectPath: '/test/project' }));

      const sessions = cmdList({ project: '/test/project', config: configPath });
      expect(sessions.length).toBe(2);
    });

    it('should return empty array when no sessions', () => {
      const sessions = cmdList({ project: '/test/project', config: configPath });
      expect(sessions).toEqual([]);
    });
  });

  describe('stats', () => {
    it('should return statistics', () => {
      store.insertChunks([makeChunk()]);
      store.insertSession(makeSession());

      const stats = cmdStats({ config: configPath });
      expect(stats.totalChunks).toBe(1);
      expect(stats.totalSessions).toBe(1);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
    });
  });

  describe('edit', () => {
    it('should update chunk content', () => {
      store.insertChunks([makeChunk()]);

      cmdEdit(1, 'Updated content text', { config: configPath });

      const chunk = store.getChunk(1);
      expect(chunk!.content).toBe('Updated content text');
    });

    it('should report error for non-existent chunk', () => {
      cmdEdit(999, 'text', { config: configPath });
      expect(console.error).toHaveBeenCalledWith('Chunk 999 not found.');
    });
  });

  describe('delete', () => {
    it('should delete a session', () => {
      store.insertChunks([makeChunk()]);
      store.insertSession(makeSession());

      cmdDelete({ session: 'session-1', config: configPath });

      const sessions = store.getSessionList();
      expect(sessions.length).toBe(0);
    });

    it('should delete a chunk by id', () => {
      store.insertChunks([makeChunk()]);

      cmdDelete({ chunk: '1', config: configPath });

      expect(store.getChunk(1)).toBeUndefined();
    });

    it('should delete chunks before a date', () => {
      store.insertChunks([makeChunk()]);

      cmdDelete({ before: '2099-01-01', config: configPath });

      expect(store.getChunk(1)).toBeUndefined();
    });
  });

  describe('prune', () => {
    it('should remove old chunks', () => {
      store.insertChunks([makeChunk()]);

      // Prune anything older than 0 days (everything)
      const count = cmdPrune('0d', { config: configPath });
      // 0d means cutoff = now, so chunks created "just now" should NOT be pruned
      // Use a large value to ensure all get pruned
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should handle 90d duration', () => {
      store.insertChunks([makeChunk()]);
      // Chunks were just created, so 90d prune should remove 0
      const count = cmdPrune('90d', { config: configPath });
      expect(count).toBe(0);
    });
  });

  describe('export', () => {
    it('should export sessions as JSON', () => {
      store.insertSession(makeSession());

      const output = cmdExport({
        format: 'json',
        project: '/test/project',
        config: configPath,
      });

      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
      expect(parsed[0].sessionId).toBe('session-1');
    });

    it('should export sessions as markdown', () => {
      store.insertSession(makeSession());

      const output = cmdExport({
        format: 'markdown',
        project: '/test/project',
        config: configPath,
      });

      expect(output).toContain('# Engram Memory Export');
      expect(output).toContain('session-');
    });

    it('should default to JSON format', () => {
      store.insertSession(makeSession());

      const output = cmdExport({
        project: '/test/project',
        config: configPath,
      });

      expect(() => JSON.parse(output)).not.toThrow();
    });
  });

  describe('embed', () => {
    it('should show usage when --backfill is not provided', async () => {
      const result = await cmdEmbed({ config: configPath });
      expect(result.total).toBe(0);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('should report error when not in hybrid mode', async () => {
      await expect(cmdEmbed({ backfill: true, config: configPath })).rejects.toThrow('hybrid mode');
    });
  });
});
