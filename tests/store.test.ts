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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-store-'));
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

    it('同一 session の再保存で UNIQUE 違反を出さず、最新内容で置き換える', () => {
      // 初回: 2 chunks
      store.insertChunks([
        makeChunk({ chunkIndex: 0, content: 'first version chunk 0' }),
        makeChunk({ chunkIndex: 1, content: 'first version chunk 1' }),
      ]);

      // 再保存: 同じ session_id + chunk_index で内容を更新 + 新規 chunk 追加
      expect(() =>
        store.insertChunks([
          makeChunk({ chunkIndex: 0, content: 'second version chunk 0' }),
          makeChunk({ chunkIndex: 1, content: 'second version chunk 1' }),
          makeChunk({ chunkIndex: 2, content: 'second version chunk 2 (new)' }),
        ])
      ).not.toThrow();

      const rows = db
        .prepare(
          'SELECT chunk_index, content FROM chunks WHERE session_id = ? ORDER BY chunk_index'
        )
        .all('session-1') as { chunk_index: number; content: string }[];
      expect(rows).toHaveLength(3);
      expect(rows[0].content).toBe('second version chunk 0');
      expect(rows[1].content).toBe('second version chunk 1');
      expect(rows[2].content).toBe('second version chunk 2 (new)');
    });

    it('別 session の chunks は再保存時に削除されない', () => {
      store.insertChunks([makeChunk({ sessionId: 'session-a', chunkIndex: 0, content: 'A0' })]);
      store.insertChunks([makeChunk({ sessionId: 'session-b', chunkIndex: 0, content: 'B0' })]);

      // session-a を再保存しても session-b は残る
      store.insertChunks([
        makeChunk({ sessionId: 'session-a', chunkIndex: 0, content: 'A0-updated' }),
      ]);

      const bRows = db
        .prepare('SELECT content FROM chunks WHERE session_id = ?')
        .all('session-b') as { content: string }[];
      expect(bRows).toHaveLength(1);
      expect(bRows[0].content).toBe('B0');
    });

    it('空配列を渡しても安全に no-op で完了する', () => {
      expect(() => store.insertChunks([])).not.toThrow();
      const row = db.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number };
      expect(row.count).toBe(0);
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
