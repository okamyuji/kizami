import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getDatabase } from '../src/db/connection';
import { initializeSchema } from '../src/db/schema';
import { Store } from '../src/db/store';
import type { Chunk, Session } from '../src/db/store';

describe('store', () => {
  let db: Database.Database;
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-store-'));
    db = getDatabase(path.join(tmpDir, 'test.db'));
    initializeSchema(db);
    store = new Store(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
    return {
      sessionId: 'session-1',
      projectPath: '/test/project',
      chunkIndex: 0,
      content: 'Test chunk content with enough text for searching',
      role: 'human',
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: 10,
      ...overrides,
    };
  }

  describe('insertChunks', () => {
    it('should insert chunks', () => {
      const chunks = [makeChunk(), makeChunk({ chunkIndex: 1, content: 'Second chunk content' })];
      store.insertChunks(chunks);

      const row = db.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number };
      expect(row.count).toBe(2);
    });
  });

  describe('getChunk', () => {
    it('should get a chunk by id', () => {
      store.insertChunks([makeChunk()]);
      const chunk = store.getChunk(1);
      expect(chunk).toBeDefined();
      expect(chunk!.sessionId).toBe('session-1');
      expect(chunk!.content).toBe('Test chunk content with enough text for searching');
    });

    it('should return undefined for non-existent id', () => {
      expect(store.getChunk(999)).toBeUndefined();
    });
  });

  describe('updateChunkContent', () => {
    it('should update chunk content', () => {
      store.insertChunks([makeChunk()]);
      store.updateChunkContent(1, 'Updated content for the chunk');
      const chunk = store.getChunk(1);
      expect(chunk!.content).toBe('Updated content for the chunk');
    });
  });

  describe('deleteChunk', () => {
    it('should delete a chunk', () => {
      store.insertChunks([makeChunk()]);
      store.deleteChunk(1);
      expect(store.getChunk(1)).toBeUndefined();
    });
  });

  describe('insertSession / getSessionList', () => {
    it('should insert and list sessions', () => {
      const session: Session = {
        sessionId: 'session-1',
        projectPath: '/test/project',
        startedAt: '2024-01-01T00:00:00Z',
        chunkCount: 5,
        firstMessage: 'Hello',
        lastMessage: 'Bye',
      };
      store.insertSession(session);

      const sessions = store.getSessionList('/test/project');
      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe('session-1');
    });

    it('should list all sessions without project filter', () => {
      store.insertSession({
        sessionId: 's1',
        projectPath: '/project-a',
      });
      store.insertSession({
        sessionId: 's2',
        projectPath: '/project-b',
      });

      const sessions = store.getSessionList();
      expect(sessions.length).toBe(2);
    });
  });

  describe('deleteSession', () => {
    it('should delete session and its chunks', () => {
      store.insertChunks([makeChunk()]);
      store.insertSession({ sessionId: 'session-1', projectPath: '/test/project' });

      store.deleteSession('session-1');

      expect(store.getChunk(1)).toBeUndefined();
      const sessions = store.getSessionList();
      expect(sessions.length).toBe(0);
    });
  });

  describe('deleteChunksBefore', () => {
    it('should delete chunks before a given date', () => {
      store.insertChunks([makeChunk()]);
      // Delete everything before a far future date
      const deleted = store.deleteChunksBefore('2099-01-01T00:00:00Z');
      expect(deleted).toBe(1);
    });
  });

  describe('searchFTS', () => {
    it('should find chunks via FTS5 search', () => {
      store.insertChunks([
        makeChunk({ content: 'React Hook Form implementation details' }),
        makeChunk({
          chunkIndex: 1,
          content: 'Python Django REST framework setup',
        }),
      ]);

      const results = store.searchFTS('React Hook', '/test/project', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain('React');
    });
  });

  describe('searchLike', () => {
    it('should find chunks via LIKE search (short queries)', () => {
      store.insertChunks([makeChunk({ content: 'Using JS and TS for development' })]);

      const results = store.searchLike('JS', '/test/project', 10);
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('JS');
    });
  });

  describe('getStats', () => {
    it('should return statistics', () => {
      store.insertChunks([makeChunk()]);
      store.insertSession({ sessionId: 'session-1', projectPath: '/test/project' });

      const stats = store.getStats();
      expect(stats.totalChunks).toBe(1);
      expect(stats.totalSessions).toBe(1);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
    });
  });
});
