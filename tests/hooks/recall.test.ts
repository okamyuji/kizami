import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';
import { Store } from '../../src/db/store';
import type { Chunk } from '../../src/db/store';
import { handleRecall } from '../../src/hooks/recall';

describe('handleRecall', () => {
  let db: Database.Database;
  let store: Store;
  let tmpDir: string;
  let dbPath: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-recall-'));
    dbPath = path.join(tmpDir, 'test.db');
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ database: { path: dbPath } }), 'utf-8');
    db = getDatabase(dbPath);
    initializeSchema(db);
    store = new Store(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
    return {
      sessionId: 'session-1',
      projectPath: fs.realpathSync(tmpDir),
      chunkIndex: 0,
      content: 'Default chunk content for testing purposes',
      role: 'human',
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: 10,
      ...overrides,
    };
  }

  it('should return formatted results for matching query', async () => {
    store.insertChunks([
      makeChunk({ content: 'React Hook Form implementation details for the project' }),
      makeChunk({
        chunkIndex: 1,
        content: 'Python Django REST framework setup guide',
      }),
    ]);
    // Close test DB so handleRecall can open its own connection without WAL contention
    db.close();

    const result = await handleRecall(
      {
        prompt: 'React Hook',
        session_id: 'current-session',
        cwd: tmpDir,
      },
      configPath
    );

    expect(result).toContain('React');
    expect(result).toContain('[Past Memory]');
  });

  it('should return empty string when no matches found', async () => {
    store.insertChunks([makeChunk({ content: 'React Hook Form implementation details' })]);
    db.close();

    const result = await handleRecall(
      {
        prompt: 'xyznonexistent',
        session_id: 'current-session',
        cwd: tmpDir,
      },
      configPath
    );

    expect(result).toBe('');
  });

  it('should return empty string for empty prompt', async () => {
    store.insertChunks([makeChunk()]);
    db.close();

    const result = await handleRecall(
      {
        prompt: '',
        session_id: 'current-session',
        cwd: tmpDir,
      },
      configPath
    );

    expect(result).toBe('');
  });

  it('should scope results to current project by default', async () => {
    const resolvedTmp = fs.realpathSync(tmpDir);
    store.insertChunks([
      makeChunk({
        content: 'React in correct project for testing',
        projectPath: resolvedTmp,
      }),
      makeChunk({
        chunkIndex: 1,
        content: 'React in other project for testing',
        projectPath: '/other/project',
        sessionId: 'session-2',
      }),
    ]);
    db.close();

    const result = await handleRecall(
      {
        prompt: 'React',
        session_id: 'current-session',
        cwd: tmpDir,
      },
      configPath
    );

    expect(result).toContain('correct project');
    expect(result).not.toContain('other project');
  });
});
