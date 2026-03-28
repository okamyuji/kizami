import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';
import { Store } from '../../src/db/store';
import type { Chunk } from '../../src/db/store';
import { searchFts } from '../../src/search/fts';

describe('searchFts', () => {
  let db: Database.Database;
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-fts-'));
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
      content: 'Default chunk content for testing purposes',
      role: 'human',
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: 10,
      ...overrides,
    };
  }

  it('should use FTS for queries with 3+ characters', () => {
    store.insertChunks([
      makeChunk({ content: 'React Hook Form implementation details' }),
      makeChunk({ chunkIndex: 1, content: 'Python Django REST framework' }),
    ]);

    const results = searchFts(store, {
      query: 'React Hook',
      projectPath: '/test/project',
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain('React');
    // FTS results should have rank
    expect(results[0].rank).toBeDefined();
  });

  it('should use LIKE for queries with 2 or fewer characters', () => {
    store.insertChunks([makeChunk({ content: 'Using JS and TS for development' })]);

    const results = searchFts(store, {
      query: 'JS',
      projectPath: '/test/project',
    });

    expect(results.length).toBe(1);
    expect(results[0].content).toContain('JS');
    // LIKE results do not have rank
    expect(results[0].rank).toBeUndefined();
  });

  it('should return empty array for empty query', () => {
    store.insertChunks([makeChunk()]);

    const results = searchFts(store, {
      query: '',
      projectPath: '/test/project',
    });

    expect(results).toEqual([]);
  });

  it('should respect limit option', () => {
    store.insertChunks([
      makeChunk({ content: 'First React component guide' }),
      makeChunk({ chunkIndex: 1, content: 'Second React hooks tutorial' }),
      makeChunk({ chunkIndex: 2, content: 'Third React patterns overview' }),
    ]);

    const results = searchFts(store, {
      query: 'React',
      projectPath: '/test/project',
      limit: 2,
    });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('should filter by project path', () => {
    store.insertChunks([
      makeChunk({ content: 'React in project A', projectPath: '/project-a' }),
      makeChunk({
        chunkIndex: 1,
        content: 'React in project B',
        projectPath: '/project-b',
      }),
    ]);

    const results = searchFts(store, {
      query: 'React',
      projectPath: '/project-a',
    });

    expect(results.length).toBe(1);
    expect(results[0].content).toContain('project A');
  });

  it('should search all projects when allProjects is true', () => {
    store.insertChunks([
      makeChunk({ content: 'React in project A', projectPath: '/project-a' }),
      makeChunk({
        chunkIndex: 1,
        content: 'React in project B',
        projectPath: '/project-b',
        sessionId: 'session-2',
      }),
    ]);

    const results = searchFts(store, {
      query: 'React',
      projectPath: '/project-a',
      allProjects: true,
    });

    expect(results.length).toBe(2);
  });

  it('should use LIKE for short queries with allProjects', () => {
    store.insertChunks([
      makeChunk({ content: 'JS stuff', projectPath: '/project-a' }),
      makeChunk({
        chunkIndex: 1,
        content: 'JS more',
        projectPath: '/project-b',
        sessionId: 'session-2',
      }),
    ]);

    const results = searchFts(store, {
      query: 'JS',
      projectPath: '/project-a',
      allProjects: true,
    });

    expect(results.length).toBe(2);
  });
});
