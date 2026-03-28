import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { importClaudeMem } from '../../src/import/claude-mem';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';

const CLAUDE_MEM_SCHEMA = `
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT UNIQUE NOT NULL,
  memory_session_id TEXT UNIQUE,
  project TEXT NOT NULL,
  user_prompt TEXT,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  completed_at TEXT,
  completed_at_epoch INTEGER,
  status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active',
  worker_port INTEGER,
  prompt_counter INTEGER DEFAULT 0
);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  text TEXT,
  type TEXT NOT NULL,
  title TEXT,
  subtitle TEXT,
  facts TEXT,
  narrative TEXT,
  concepts TEXT,
  files_read TEXT,
  files_modified TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
);

CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  files_read TEXT,
  files_edited TEXT,
  notes TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
);
`;

function seedClaudeMemDb(db: Database.Database): void {
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'content-1',
    'mem-session-1',
    'my-project',
    'Fix the login bug',
    '2024-06-01T10:00:00Z',
    1717236000,
    '2024-06-01T11:00:00Z',
    1717239600,
    'completed'
  );

  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'content-2',
    'mem-session-2',
    'other-project',
    'Add tests',
    '2024-06-02T10:00:00Z',
    1717322400,
    'active'
  );

  // Observations for session 1
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, files_read, files_modified, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'mem-session-1',
    'my-project',
    'bugfix',
    'Fixed login race condition',
    'The login form had a race condition causing double submissions.',
    'Race condition in useEffect cleanup',
    'src/login.ts,src/auth.ts',
    'src/login.ts',
    '2024-06-01T10:15:00Z',
    1717236900
  );

  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, files_read, files_modified, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'mem-session-1',
    'my-project',
    'discovery',
    'Auth module architecture',
    'The auth module uses a provider pattern.',
    'Provider pattern with context',
    '["src/auth/provider.ts"]',
    null,
    '2024-06-01T10:30:00Z',
    1717237800
  );

  // Observation for session 2
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, files_read, files_modified, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'mem-session-2',
    'other-project',
    'feature',
    'Added unit tests',
    'Created test suite for user service.',
    null,
    null,
    'tests/user.test.ts',
    '2024-06-02T10:15:00Z',
    1717323300
  );

  // Summary for session 1
  db.prepare(
    `INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'mem-session-1',
    'my-project',
    'Fix the login bug',
    'Login form submission flow',
    'Race condition in useEffect',
    'Fixed double submission bug',
    'Add integration tests',
    'src/login.ts',
    'src/login.ts',
    '2024-06-01T11:00:00Z',
    1717239600
  );
}

describe('importClaudeMem', () => {
  let tmpDir: string;
  let sourceDbPath: string;
  let engramDbPath: string;
  let engramConfigPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-import-'));
    sourceDbPath = path.join(tmpDir, 'claude-mem.db');
    engramDbPath = path.join(tmpDir, 'engram.db');
    engramConfigPath = path.join(tmpDir, 'config.json');

    // Create config pointing to tmp engram DB
    fs.writeFileSync(engramConfigPath, JSON.stringify({ database: { path: engramDbPath } }));

    // Create and seed the claude-mem DB
    const sourceDb = new Database(sourceDbPath);
    sourceDb.exec(CLAUDE_MEM_SCHEMA);
    seedClaudeMemDb(sourceDb);
    sourceDb.close();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should import all sessions, observations, and summaries', async () => {
    const result = await importClaudeMem({
      sourcePath: sourceDbPath,
      configPath: engramConfigPath,
    });

    expect(result.sessionsImported).toBe(2);
    // Session 1: 2 observations + 1 summary = 3 chunks
    // Session 2: 1 observation = 1 chunk
    expect(result.chunksImported).toBe(4);
    expect(result.skipped).toBe(0);

    // Verify in engram DB
    const engramDb = getDatabase(engramDbPath);
    initializeSchema(engramDb);
    try {
      const chunks = engramDb
        .prepare('SELECT * FROM chunks WHERE session_id = ? ORDER BY chunk_index')
        .all('mem-session-1') as Record<string, unknown>[];
      expect(chunks.length).toBe(3);

      // First observation
      expect(chunks[0]['chunk_index']).toBe(0);
      expect(chunks[0]['content'] as string).toContain('[claude-mem observation: bugfix]');
      expect(chunks[0]['content'] as string).toContain('Fixed login race condition');
      expect(chunks[0]['project_path'] as string).toBe('claude-mem:my-project');

      // Check metadata has file paths
      const meta0 = JSON.parse(chunks[0]['metadata'] as string);
      expect(meta0.filePaths).toContain('src/login.ts');
      expect(meta0.filePaths).toContain('src/auth.ts');
      expect(meta0.toolNames).toEqual(['bugfix']);

      // Second observation with JSON array files_read
      const meta1 = JSON.parse(chunks[1]['metadata'] as string);
      expect(meta1.filePaths).toContain('src/auth/provider.ts');

      // Summary chunk at offset 10000
      expect(chunks[2]['chunk_index']).toBe(10000);
      expect(chunks[2]['content'] as string).toContain('[claude-mem summary]');
      expect(chunks[2]['content'] as string).toContain('Request: Fix the login bug');

      // Verify session was created
      const sessions = engramDb
        .prepare('SELECT * FROM sessions WHERE session_id = ?')
        .all('mem-session-1') as Record<string, unknown>[];
      expect(sessions.length).toBe(1);
      expect(sessions[0]['project_path']).toBe('claude-mem:my-project');
      expect(sessions[0]['first_message']).toBe('Fix the login bug');
      expect(sessions[0]['chunk_count']).toBe(3);
    } finally {
      engramDb.close();
    }
  });

  it('should skip already-imported sessions (idempotency)', async () => {
    // First import
    await importClaudeMem({
      sourcePath: sourceDbPath,
      configPath: engramConfigPath,
    });

    // Second import — same data
    const result = await importClaudeMem({
      sourcePath: sourceDbPath,
      configPath: engramConfigPath,
    });

    expect(result.sessionsImported).toBe(0);
    expect(result.chunksImported).toBe(0);
    expect(result.skipped).toBe(2);

    // Verify no duplicates
    const engramDb = getDatabase(engramDbPath);
    initializeSchema(engramDb);
    try {
      const row = engramDb.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
        count: number;
      };
      expect(row.count).toBe(4);
    } finally {
      engramDb.close();
    }
  });

  it('should filter by project name', async () => {
    const result = await importClaudeMem({
      sourcePath: sourceDbPath,
      configPath: engramConfigPath,
      project: 'my-project',
    });

    expect(result.sessionsImported).toBe(1);
    expect(result.chunksImported).toBe(3); // 2 observations + 1 summary
    expect(result.skipped).toBe(0);
  });

  it('should support dry-run mode', async () => {
    const result = await importClaudeMem({
      sourcePath: sourceDbPath,
      configPath: engramConfigPath,
      dryRun: true,
    });

    expect(result.sessionsImported).toBe(2);
    expect(result.chunksImported).toBe(4);
    expect(result.skipped).toBe(0);

    // Verify nothing was actually written
    const engramDb = getDatabase(engramDbPath);
    initializeSchema(engramDb);
    try {
      const row = engramDb.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
        count: number;
      };
      expect(row.count).toBe(0);
    } finally {
      engramDb.close();
    }
  });

  it('should skip sessions with no memory_session_id', async () => {
    // Add a session with null memory_session_id
    const sourceDb = new Database(sourceDbPath);
    sourceDb
      .prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('content-3', null, 'my-project', '2024-06-03T10:00:00Z', 1717408800, 'active');
    sourceDb.close();

    const result = await importClaudeMem({
      sourcePath: sourceDbPath,
      configPath: engramConfigPath,
    });

    // 2 regular sessions imported + 1 null-session skipped
    expect(result.sessionsImported).toBe(2);
    expect(result.skipped).toBe(1);
  });
});
