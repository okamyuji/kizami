import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { copyRecentTranscript } from '../helpers/recent-transcript';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';
import { Store } from '../../src/db/store';
import { recoverTranscripts, projectDirToPath } from '../../src/hooks/recover';
import {
  recordSessionDeletion,
  recordChunkDeletion,
  deletionsFile,
} from '../../src/archive/deletions';
import { writePendingPrompt } from '../../src/checkpoint/state';
import { foldCanonicalHistory } from '../../src/jsonl/fold';
import { listJsonlFiles } from '../../src/jsonl/path';
import { checkpointStop } from '../../src/checkpoint/service';

describe('projectDirToPath', () => {
  it('should convert project dir name to filesystem path', () => {
    expect(projectDirToPath('-Users-yujiokamoto')).toBe('/Users/yujiokamoto');
    expect(projectDirToPath('-Users-yujiokamoto-devs-claude')).toBe(
      '/Users/yujiokamoto/devs/claude'
    );
    expect(projectDirToPath('-tmp')).toBe('/tmp');
  });
});

describe('recoverTranscripts', () => {
  let tmpDir: string;
  let dbPath: string;
  let jsonlDir: string;
  let configPath: string;
  let fakeProjectsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-recover-'));
    dbPath = path.join(tmpDir, 'test.db');
    jsonlDir = path.join(tmpDir, 'jsonl');
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ database: { path: dbPath }, storage: { jsonlDir } }),
      'utf-8'
    );

    // ~/.claude/projects/ の代わりとなるフェイクディレクトリ
    fakeProjectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(fakeProjectsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should recover unsaved transcript files', async () => {
    // フェイクプロジェクトディレクトリにトランスクリプトを配置
    const projectDir = path.join(fakeProjectsDir, '-tmp-testproject');
    fs.mkdirSync(projectDir, { recursive: true });
    copyRecentTranscript(path.join(projectDir, 'unsaved-session-1.jsonl'));

    const result = await recoverTranscripts(configPath, fakeProjectsDir);

    expect(result.recovered).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toContain('unsaved-');

    // DBに保存されていることを確認
    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    expect(store.hasSession('unsaved-session-1')).toBe(true);
    const sessions = store.getSessionList();
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe('unsaved-session-1');
    expect(sessions[0].chunkCount).toBeGreaterThan(0);
    const jsonlFiles = fs.readdirSync(jsonlDir).filter((f) => f.endsWith('.jsonl'));
    expect(jsonlFiles.length).toBe(1);

    db.close();
  });

  const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
  const writeSession = (dirName: string, sessionId: string, lines: string[]) => {
    const dir = path.join(fakeProjectsDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf-8');
  };
  const queryRows = <T>(sql: string): T[] => {
    const db = getDatabase(dbPath);
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  };
  const turn = (cwd: string | undefined, ts: string) => [
    line({
      type: 'user',
      ...(cwd ? { cwd } : {}),
      message: { role: 'user', content: [{ type: 'text', text: 'question' }] },
      sessionId: 's',
      timestamp: ts,
    }),
    line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      sessionId: 's',
      timestamp: ts,
    }),
  ];

  it('should store the conversation time as chunk created_at, not the import time', async () => {
    writeSession('-tmp-p', 'aaaa1111', turn(undefined, '2026-10-05T06:44:12.345Z'));

    await recoverTranscripts(configPath, fakeProjectsDir);

    expect(queryRows<{ created_at: string }>('SELECT created_at FROM chunks')).toEqual([
      { created_at: '2026-10-05T06:44:12.345Z' },
    ]);
    const records = fs
      .readdirSync(jsonlDir)
      .flatMap((f) => fs.readFileSync(path.join(jsonlDir, f), 'utf-8').trim().split('\n'))
      .map((l) => JSON.parse(l) as { createdAt: string });
    expect(records.map((r) => r.createdAt)).toEqual(['2026-10-05T06:44:12.345Z']);
  });

  it('should fall back to the import time when the transcript has no timestamps', async () => {
    const noTs = turn(undefined, 'x').map((l) => {
      const o = JSON.parse(l);
      delete o.timestamp;
      return line(o);
    });
    writeSession('-tmp-p', 'bbbb2222', noTs);
    const before = Date.now();

    await recoverTranscripts(configPath, fakeProjectsDir);

    const [row] = queryRows<{ created_at: string }>('SELECT created_at FROM chunks');
    expect(Date.parse(row.created_at)).toBeGreaterThanOrEqual(before);
  });

  it.each([
    ['-Users-me-devs-golang-go-llm-agent', '/Users/me/devs/golang/go-llm-agent'],
    ['-Users-me-devs-my-app-v1-2', '/Users/me/devs/my.app_v1-2'],
    ['-Users-me--claude', '/Users/me/.claude'],
  ])('should use the transcript cwd for %s instead of decoding the dir name', async (dir, cwd) => {
    writeSession(dir, 'cccc3333', turn(cwd, '2026-10-05T06:44:12.345Z'));

    await recoverTranscripts(configPath, fakeProjectsDir);

    expect(queryRows<{ project_path: string }>('SELECT project_path FROM sessions')).toEqual([
      { project_path: cwd },
    ]);
    expect(queryRows<{ project_path: string }>('SELECT DISTINCT project_path FROM chunks')).toEqual(
      [{ project_path: cwd }]
    );
  });

  it('should use the Windows cwd as recorded', async () => {
    const cwd = 'C:\\Users\\me\\my-proj';
    writeSession('C--Users-me-my-proj', 'dddd4444', turn(cwd, '2026-10-05T06:44:12.345Z'));

    await recoverTranscripts(configPath, fakeProjectsDir);

    expect(queryRows<{ project_path: string }>('SELECT project_path FROM sessions')).toEqual([
      { project_path: cwd },
    ]);
  });

  it('should fall back to the decoded dir name when no line has a cwd', async () => {
    writeSession('C--Users-me-proj', 'eeee5555', turn(undefined, '2026-10-05T06:44:12.345Z'));
    writeSession('-tmp-nocwd', 'ffff6666', turn(undefined, '2026-10-05T06:44:12.345Z'));

    await recoverTranscripts(configPath, fakeProjectsDir);

    expect(
      queryRows<{ project_path: string }>('SELECT project_path FROM sessions ORDER BY session_id')
    ).toEqual([{ project_path: 'C:\\Users\\me\\proj' }, { project_path: '/tmp/nocwd' }]);
  });

  it('should read cwd per session when one directory holds sessions of different cwd', async () => {
    writeSession('-tmp-x', 'aaaa0001', turn('/tmp/x-one', '2026-10-05T06:44:12.345Z'));
    writeSession('-tmp-x', 'aaaa0002', turn('/tmp/x.two', '2026-10-05T06:44:12.345Z'));

    await recoverTranscripts(configPath, fakeProjectsDir);

    expect(
      queryRows<{ project_path: string }>('SELECT project_path FROM sessions ORDER BY session_id')
    ).toEqual([{ project_path: '/tmp/x-one' }, { project_path: '/tmp/x.two' }]);
  });

  it('should apply projectAliases on top of the transcript cwd', async () => {
    const aliasConfig = path.join(tmpDir, 'config-alias2.json');
    fs.writeFileSync(
      aliasConfig,
      JSON.stringify({
        database: { path: dbPath },
        storage: { jsonlDir, projectAliases: { '/Users/me/go-llm-agent': '/canonical/agent' } },
      }),
      'utf-8'
    );
    writeSession(
      '-Users-me-go-llm-agent',
      'aaaa7777',
      turn('/Users/me/go-llm-agent', '2026-10-05T06:44:12.345Z')
    );

    await recoverTranscripts(aliasConfig, fakeProjectsDir);

    expect(queryRows<{ project_path: string }>('SELECT project_path FROM sessions')).toEqual([
      { project_path: '/canonical/agent' },
    ]);
  });

  describe('retention', () => {
    const NOW = new Date('2026-10-17T12:00:00.000Z');
    const cutoff = new Date(NOW);
    cutoff.setDate(cutoff.getDate() - 90);
    const at = (ms: number) => new Date(cutoff.getTime() + ms).toISOString();

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const sessionCount = () => queryRows<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')[0].n;

    it('does not import a conversation that ended before the retention cutoff', async () => {
      writeSession('-tmp-p', 'old00001', turn(undefined, at(-1)));

      const result = await recoverTranscripts(configPath, fakeProjectsDir);

      expect(result.recovered).toBe(0);
      expect(result.skipped).toBe(1);
      expect(sessionCount()).toBe(0);
    });

    it('imports a conversation that ended exactly at the cutoff', async () => {
      writeSession('-tmp-p', 'edge0001', turn(undefined, at(0)));

      const result = await recoverTranscripts(configPath, fakeProjectsDir);

      expect(result.recovered).toBe(1);
      expect(queryRows<{ created_at: string }>('SELECT created_at FROM chunks')).toEqual([
        { created_at: at(0) },
      ]);
    });

    it('imports an old conversation when retention is disabled', async () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          database: { path: dbPath },
          storage: { jsonlDir },
          maintenance: { enabled: false },
        }),
        'utf-8'
      );
      writeSession('-tmp-p', 'old00002', turn(undefined, at(-1)));

      expect((await recoverTranscripts(configPath, fakeProjectsDir)).recovered).toBe(1);
    });

    it('stops re-importing after maintenance deleted the aged session', async () => {
      writeSession('-tmp-p', 'keep0001', turn(undefined, at(1000)));
      writeSession('-tmp-p', 'old00003', turn(undefined, at(-1000)));
      await recoverTranscripts(configPath, fakeProjectsDir);
      const db = getDatabase(dbPath);
      initializeSchema(db);
      const store = new Store(db);
      store.deleteChunksBefore(cutoff.toISOString());
      store.deleteOrphanedSessions();
      db.close();

      const again = await recoverTranscripts(configPath, fakeProjectsDir);

      expect(again.recovered).toBe(0);
      expect(queryRows<{ session_id: string }>('SELECT session_id FROM sessions')).toEqual([
        { session_id: 'keep0001' },
      ]);
    });
  });

  it('should apply storage.projectAliases to the recovered projectPath', async () => {
    // 共有JSONLを複数ホストで同期していると、同じ論理プロジェクトでも
    // ホストごとにプロジェクトディレクトリ名が変わる。save / recall / inject と同じく
    // 取り込み経路でも対応表を通さないと、このホストの分だけ別プロジェクトになる。
    const aliasConfig = path.join(tmpDir, 'config-alias.json');
    fs.writeFileSync(
      aliasConfig,
      JSON.stringify({
        database: { path: dbPath },
        storage: { jsonlDir, projectAliases: { '/tmp/testproject': '/canonical/project' } },
      }),
      'utf-8'
    );

    const projectDir = path.join(fakeProjectsDir, '-tmp-testproject');
    fs.mkdirSync(projectDir, { recursive: true });
    copyRecentTranscript(path.join(projectDir, 'aliased-session.jsonl'));

    const result = await recoverTranscripts(aliasConfig, fakeProjectsDir);
    expect(result.recovered).toBe(1);

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);
    const sessions = store.getSessionList();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectPath).toBe('/canonical/project');
    db.close();
  });

  it('should leave the projectPath untouched when no alias matches', async () => {
    const aliasConfig = path.join(tmpDir, 'config-noalias.json');
    fs.writeFileSync(
      aliasConfig,
      JSON.stringify({
        database: { path: dbPath },
        storage: { jsonlDir, projectAliases: { '/tmp/other': '/canonical/other' } },
      }),
      'utf-8'
    );

    const projectDir = path.join(fakeProjectsDir, '-tmp-testproject');
    fs.mkdirSync(projectDir, { recursive: true });
    copyRecentTranscript(path.join(projectDir, 'unaliased-session.jsonl'));

    const result = await recoverTranscripts(aliasConfig, fakeProjectsDir);
    expect(result.recovered).toBe(1);

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);
    const sessions = store.getSessionList();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectPath).toBe('/tmp/testproject');
    db.close();
  });

  it('skips sessions recorded as deleted', async () => {
    const projectDir = path.join(fakeProjectsDir, '-tmp-testproject');
    fs.mkdirSync(projectDir, { recursive: true });
    copyRecentTranscript(path.join(projectDir, 'deleted-session-1.jsonl'));
    recordSessionDeletion(deletionsFile(dbPath), 'deleted-session-1');

    const result = await recoverTranscripts(configPath, fakeProjectsDir);

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    const db = getDatabase(dbPath);
    initializeSchema(db);
    expect(new Store(db).hasSession('deleted-session-1')).toBe(false);
    db.close();
  });

  it('should skip already saved sessions', async () => {
    // 先にDBにセッションを保存
    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);
    store.insertSession({
      sessionId: 'already-saved',
      projectPath: '/tmp/testproject',
    });
    db.close();

    // 同じセッションIDのトランスクリプトファイルを配置
    const projectDir = path.join(fakeProjectsDir, '-tmp-testproject');
    fs.mkdirSync(projectDir, { recursive: true });
    copyRecentTranscript(path.join(projectDir, 'already-saved.jsonl'));

    const result = await recoverTranscripts(configPath, fakeProjectsDir);

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('should skip empty transcript files', async () => {
    const projectDir = path.join(fakeProjectsDir, '-tmp-testproject');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'empty-session.jsonl'), '', 'utf-8');

    const result = await recoverTranscripts(configPath, fakeProjectsDir);

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('should handle multiple projects and transcripts', async () => {
    const projectDir1 = path.join(fakeProjectsDir, '-tmp-project1');
    const projectDir2 = path.join(fakeProjectsDir, '-tmp-project2');
    fs.mkdirSync(projectDir1, { recursive: true });
    fs.mkdirSync(projectDir2, { recursive: true });

    copyRecentTranscript(path.join(projectDir1, 'session-a.jsonl'));
    copyRecentTranscript(path.join(projectDir2, 'session-b.jsonl'));

    const result = await recoverTranscripts(configPath, fakeProjectsDir);

    expect(result.recovered).toBe(2);
    expect(result.errors).toBe(0);

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    expect(store.hasSession('session-a')).toBe(true);
    expect(store.hasSession('session-b')).toBe(true);

    db.close();
  });

  it('should return empty result when projects dir does not exist', async () => {
    const nonexistent = path.join(tmpDir, 'nonexistent');
    const result = await recoverTranscripts(configPath, nonexistent);

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('should ignore non-jsonl files', async () => {
    const projectDir = path.join(fakeProjectsDir, '-tmp-testproject');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'readme.txt'), 'not a transcript', 'utf-8');
    fs.writeFileSync(path.join(projectDir, 'data.json'), '{}', 'utf-8');

    const result = await recoverTranscripts(configPath, fakeProjectsDir);

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('should set correct projectPath from directory name', async () => {
    const projectDir = path.join(fakeProjectsDir, '-Users-testuser-devs-myapp');
    fs.mkdirSync(projectDir, { recursive: true });
    copyRecentTranscript(path.join(projectDir, 'path-test-session.jsonl'));

    await recoverTranscripts(configPath, fakeProjectsDir);

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    const sessions = store.getSessionList();
    const session = sessions.find((s) => s.sessionId === 'path-test-session');
    expect(session).toBeDefined();
    expect(session!.projectPath).toBe('/Users/testuser/devs/myapp');

    db.close();
  });

  it('should not re-recover on second run', async () => {
    const projectDir = path.join(fakeProjectsDir, '-tmp-testproject');
    fs.mkdirSync(projectDir, { recursive: true });
    copyRecentTranscript(path.join(projectDir, 'idempotent-session.jsonl'));

    const result1 = await recoverTranscripts(configPath, fakeProjectsDir);
    expect(result1.recovered).toBe(1);

    const result2 = await recoverTranscripts(configPath, fakeProjectsDir);
    expect(result2.recovered).toBe(0);
    expect(result2.skipped).toBe(1);
  });
});

describe('recoverTranscripts refreshes grown legacy sessions', () => {
  let tmpDir: string;
  let dbPath: string;
  let jsonlDir: string;
  let configPath: string;
  let projectsDir: string;
  let file: string;
  const SID = 'grow-0001';

  const user = (text: string, ts: string) =>
    JSON.stringify({
      type: 'user',
      sessionId: SID,
      timestamp: ts,
      message: { role: 'user', content: text },
    });
  const asst = (text: string, ts: string) =>
    JSON.stringify({
      type: 'assistant',
      sessionId: SID,
      timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-refresh-'));
    dbPath = path.join(tmpDir, 'test.db');
    jsonlDir = path.join(tmpDir, 'jsonl');
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ database: { path: dbPath }, storage: { jsonlDir } })
    );
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(path.join(projectsDir, '-w-proj'), { recursive: true });
    file = path.join(projectsDir, '-w-proj', `${SID}.jsonl`);
    fs.writeFileSync(
      file,
      [
        user('first question', '2026-09-01T00:00:00Z'),
        asst('first answer', '2026-09-01T00:01:00Z'),
      ].join('\n') + '\n'
    );
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  function appendTurn(): void {
    fs.appendFileSync(
      file,
      [
        user('appended question', '2026-09-02T00:00:00Z'),
        asst('appended answer', '2026-09-02T00:01:00Z'),
      ].join('\n') + '\n'
    );
  }

  function rows(): Array<{ content: string; turn_key: string | null; created_at: string }> {
    const db = getDatabase(dbPath);
    try {
      initializeSchema(db);
      return db
        .prepare(
          'SELECT content, turn_key, created_at FROM chunks WHERE session_id = ? ORDER BY id'
        )
        .all(SID) as Array<{ content: string; turn_key: string | null; created_at: string }>;
    } finally {
      db.close();
    }
  }

  it('replaces the legacy rows with every turn once the transcript has grown', async () => {
    await recoverTranscripts(configPath, projectsDir);
    appendTurn();

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.refreshed).toBe(1);
    expect(result.details).toEqual(['grow-000 (refreshed)']);
    const r = rows();
    expect(r.every((row) => row.turn_key !== null)).toBe(true);
    expect(r.map((row) => row.content).join('\n')).toContain('first answer');
    expect(r.map((row) => row.content).join('\n')).toContain('appended answer');
    expect(r.map((row) => row.created_at)).toEqual([
      '2026-09-01T00:01:00Z',
      '2026-09-02T00:01:00Z',
    ]);
  });

  it('keeps the refreshed session intact after a rebuild from the JSONL store', async () => {
    await recoverTranscripts(configPath, projectsDir);
    appendTurn();
    await recoverTranscripts(configPath, projectsDir);

    const history = await foldCanonicalHistory(listJsonlFiles(jsonlDir));

    expect(history.errors).toEqual([]);
    expect(history.legacyChunks.filter((c) => c.sessionId === SID)).toEqual([]);
    expect([...history.turns.values()].filter((t) => t.sessionId === SID)).toHaveLength(2);
  });

  it('does nothing on the next run when the transcript did not change', async () => {
    await recoverTranscripts(configPath, projectsDir);
    appendTurn();
    await recoverTranscripts(configPath, projectsDir);
    const before = fs.readdirSync(jsonlDir).map((f) => fs.statSync(path.join(jsonlDir, f)).size);

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.refreshed).toBe(0);
    expect(fs.readdirSync(jsonlDir).map((f) => fs.statSync(path.join(jsonlDir, f)).size)).toEqual(
      before
    );
  });

  it('marks an unmarked legacy session whose chunk count did not grow without rewriting it', async () => {
    await recoverTranscripts(configPath, projectsDir);
    fs.rmSync(path.join(tmpDir, 'recover-state.json'));
    fs.appendFileSync(file, JSON.stringify({ type: 'summary', summary: 'x' }) + '\n');

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.refreshed).toBe(0);
    expect(rows().every((row) => row.turn_key === null)).toBe(true);
    const marks = JSON.parse(fs.readFileSync(path.join(tmpDir, 'recover-state.json'), 'utf-8'));
    expect(marks.sizes[SID]).toBe(fs.statSync(file).size);
  });

  it('leaves a session with a pending prompt to the hooks', async () => {
    await recoverTranscripts(configPath, projectsDir);
    appendTurn();
    writePendingPrompt(tmpDir, {
      version: 2,
      runtime: 'claude',
      sessionId: SID,
      projectPath: '/w/proj',
      prompt: 'live',
      source: {},
      pendingKey: 'pk-1',
      turnSequence: 1,
      sourceOrder: '00000000000000000003',
      createdAt: '2026-09-02T00:00:00Z',
    });

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.refreshed).toBe(0);
    expect(rows().every((row) => row.turn_key === null)).toBe(true);
  });

  it('does not refresh a session with a deleted chunk, so the deleted text stays out', async () => {
    await recoverTranscripts(configPath, projectsDir);
    recordChunkDeletion(
      deletionsFile(dbPath),
      '[User]\nfirst question\n\n[Assistant]\nfirst answer'
    );
    appendTurn();

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.refreshed).toBe(0);
  });

  it('does not import a session again when one of its chunks was deleted and the row is gone', async () => {
    await recoverTranscripts(configPath, projectsDir);
    recordChunkDeletion(deletionsFile(dbPath), rows()[0].content);
    const db = getDatabase(dbPath);
    initializeSchema(db);
    new Store(db).deleteSession(SID);
    db.close();

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(rows()).toEqual([]);
  });

  it('does not import a session again when only one of its chunks was deleted', async () => {
    appendTurn();
    await recoverTranscripts(configPath, projectsDir);
    recordChunkDeletion(deletionsFile(dbPath), rows()[0].content);
    const db = getDatabase(dbPath);
    initializeSchema(db);
    new Store(db).deleteSession(SID);
    db.close();

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.recovered).toBe(0);
    expect(rows()).toEqual([]);
  });

  it('skips a transcript whose messages produce no chunks', async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        sessionId: SID,
        timestamp: '2026-09-01T00:00:00Z',
        message: { role: 'assistant', content: [] },
      }) + '\n'
    );

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('replaces legacy rows that a Stop hook later mixed with turn rows', async () => {
    const stop = () =>
      checkpointStop(
        'claude',
        JSON.stringify({
          session_id: SID,
          transcript_path: file,
          cwd: '/w/proj',
          hook_event_name: 'Stop',
        }),
        configPath
      );
    await recoverTranscripts(configPath, projectsDir);
    await stop();
    appendTurn();
    await stop();
    expect(rows().filter((row) => row.turn_key === null)).toHaveLength(1);

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.refreshed).toBe(1);
    expect(rows()).toHaveLength(2);
    expect(rows().every((row) => row.turn_key !== null)).toBe(true);
  });

  // root は chmod 000 でも読めるので、この失敗を起こせない。
  it.skipIf(process.getuid?.() === 0)(
    'keeps importing other sessions when refreshing one session fails',
    async () => {
      await recoverTranscripts(configPath, projectsDir);
      appendTurn();
      fs.chmodSync(file, 0o000);
      const other = path.join(projectsDir, '-w-proj', 'other-0002.jsonl');
      fs.writeFileSync(
        other,
        [
          user('other question', '2026-09-05T00:00:00Z'),
          asst('other answer', '2026-09-05T00:01:00Z'),
        ].join('\n') + '\n'
      );

      try {
        const result = await recoverTranscripts(configPath, projectsDir);

        expect(result.recovered).toBe(1);
        expect(result.errors).toBe(1);
        expect(result.details).toContainEqual(expect.stringMatching(/^grow-000: error - .*EACCES/));
        const marks = JSON.parse(fs.readFileSync(path.join(tmpDir, 'recover-state.json'), 'utf-8'));
        expect(marks.sizes['other-0002']).toBe(fs.statSync(other).size);
      } finally {
        fs.chmodSync(file, 0o644);
      }
    }
  );

  it('retries a refresh on the next run when writing it failed', async () => {
    await recoverTranscripts(configPath, projectsDir);
    appendTurn();
    const blocker = path.join(tmpDir, 'prepared');
    fs.writeFileSync(blocker, 'x');

    const failed = await recoverTranscripts(configPath, projectsDir);
    fs.rmSync(blocker);
    const retried = await recoverTranscripts(configPath, projectsDir);

    expect(failed.errors).toBe(1);
    expect(retried.refreshed).toBe(1);
    expect(
      rows()
        .map((row) => row.content)
        .join('\n')
    ).toContain('appended answer');
  });

  it('adds turns appended after a refresh without resetting the session again', async () => {
    await recoverTranscripts(configPath, projectsDir);
    appendTurn();
    await recoverTranscripts(configPath, projectsDir);
    fs.appendFileSync(
      file,
      [
        user('third question', '2026-09-03T00:00:00Z'),
        asst('third answer', '2026-09-03T00:01:00Z'),
      ].join('\n') + '\n'
    );

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.refreshed).toBe(1);
    expect(
      rows()
        .map((row) => row.content)
        .join('\n')
    ).toContain('third answer');
    expect(rows()).toHaveLength(3);
    const history = await foldCanonicalHistory(listJsonlFiles(jsonlDir));
    expect(history.errors).toEqual([]);
    expect([...history.turns.values()].filter((t) => t.sessionId === SID)).toHaveLength(3);
    expect([...history.resetSessions].filter((s) => s === SID)).toHaveLength(1);
  });

  it('leaves a session that the hooks already manage', async () => {
    await recoverTranscripts(configPath, projectsDir);
    const db = getDatabase(dbPath);
    db.prepare("UPDATE chunks SET turn_key = 'tk-hook' WHERE session_id = ?").run(SID);
    db.close();
    appendTurn();

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.refreshed).toBe(0);
    expect(rows().map((row) => row.turn_key)).toEqual(['tk-hook']);
  });
});

describe('recoverTranscripts repairs sessions imported with the wrong time or project path', () => {
  let tmpDir: string;
  let dbPath: string;
  let jsonlDir: string;
  let configPath: string;
  let projectsDir: string;
  let file: string;
  const SID = 'repair-0001';
  const CWD = '/w/go-llm-agent';
  const WRONG = '/w/go/llm/agent';

  const line = (type: 'user' | 'assistant', text: string, ts?: string) =>
    JSON.stringify({
      type,
      sessionId: SID,
      cwd: CWD,
      ...(ts ? { timestamp: ts } : {}),
      message:
        type === 'user'
          ? { role: 'user', content: text }
          : { role: 'assistant', content: [{ type: 'text', text }] },
    });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-repair-'));
    dbPath = path.join(tmpDir, 'test.db');
    jsonlDir = path.join(tmpDir, 'jsonl');
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ database: { path: dbPath }, storage: { jsonlDir } })
    );
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(path.join(projectsDir, '-w-go-llm-agent'), { recursive: true });
    file = path.join(projectsDir, '-w-go-llm-agent', `${SID}.jsonl`);
    fs.writeFileSync(
      file,
      [
        line('user', 'first question', '2026-09-01T00:00:00Z'),
        line('assistant', 'first answer', '2026-09-01T00:01:00Z'),
      ].join('\n') + '\n'
    );
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const sql = (statement: string, ...params: string[]) => {
    const db = getDatabase(dbPath);
    try {
      initializeSchema(db);
      db.prepare(statement).run(...params);
    } finally {
      db.close();
    }
  };
  const all = <T>(statement: string): T[] => {
    const db = getDatabase(dbPath);
    try {
      initializeSchema(db);
      return db.prepare(statement).all() as T[];
    } finally {
      db.close();
    }
  };
  const marker = () => path.join(tmpDir, 'recover-repaired');

  // 修復前の実装が作った状態を再現する。取り込みは正しく行われるので、後から壊す。
  async function importThenCorrupt(
    corrupt: { createdAt?: string; projectPath?: string } = {}
  ): Promise<void> {
    await recoverTranscripts(configPath, projectsDir);
    if (corrupt.createdAt) sql('UPDATE chunks SET created_at = ?', corrupt.createdAt);
    if (corrupt.projectPath) {
      sql('UPDATE chunks SET project_path = ?', corrupt.projectPath);
      sql('UPDATE sessions SET project_path = ?', corrupt.projectPath);
    }
    fs.rmSync(marker(), { force: true });
  }

  it('replaces chunks stamped with the import time by the conversation time', async () => {
    await importThenCorrupt({ createdAt: '2026-10-17T00:31:43.000Z' });

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.repaired).toBe(1);
    expect(result.details).toEqual(['repair-0 (repaired)']);
    expect(
      all<{ created_at: string; turn_key: string | null }>(
        'SELECT created_at, turn_key FROM chunks'
      ).map((r) => [r.created_at, r.turn_key !== null])
    ).toEqual([['2026-09-01T00:01:00Z', true]]);
  });

  it('repairs a project path that was decoded from the directory name', async () => {
    await importThenCorrupt({ projectPath: WRONG });

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.repaired).toBe(1);
    expect(all('SELECT project_path FROM sessions')).toEqual([{ project_path: CWD }]);
    expect(all('SELECT DISTINCT project_path FROM chunks')).toEqual([{ project_path: CWD }]);
  });

  it('detects nothing on the next run, even when the repair marker is gone', async () => {
    await importThenCorrupt({ createdAt: '2026-10-17T00:31:43.000Z', projectPath: WRONG });
    await recoverTranscripts(configPath, projectsDir);
    fs.rmSync(marker());

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.repaired).toBe(0);
  });

  it('keeps the repaired rows after a rebuild from the JSONL store', async () => {
    await importThenCorrupt({ createdAt: '2026-10-17T00:31:43.000Z', projectPath: WRONG });
    await recoverTranscripts(configPath, projectsDir);

    const history = await foldCanonicalHistory(listJsonlFiles(jsonlDir));

    expect(history.errors).toEqual([]);
    expect(history.legacyChunks.filter((c) => c.sessionId === SID)).toEqual([]);
    const turns = [...history.turns.values()].filter((t) => t.sessionId === SID);
    expect(turns).toHaveLength(1);
    expect(turns[0].projectPath).toBe(CWD);
  });

  it.each([
    ['exactly one hour after the end', '2026-09-01T01:01:00.000Z', 0],
    ['one millisecond over an hour after the end', '2026-09-01T01:01:00.001Z', 1],
    ['within the hour', '2026-09-01T00:30:00.000Z', 0],
  ])('handles a first chunk stamped %s', async (_name, createdAt, repaired) => {
    await importThenCorrupt({ createdAt });

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.repaired).toBe(repaired);
  });

  it('does not repair a v2 session by timestamp alone', async () => {
    await importThenCorrupt({ createdAt: '2026-10-17T00:31:43.000Z' });
    sql('UPDATE chunks SET turn_key = ?', 'claude:turn');

    expect((await recoverTranscripts(configPath, projectsDir)).repaired).toBe(0);
  });

  it('skips the scan once the repair marker exists', async () => {
    await importThenCorrupt({ createdAt: '2026-10-17T00:31:43.000Z' });
    fs.writeFileSync(marker(), '');

    expect((await recoverTranscripts(configPath, projectsDir)).repaired).toBe(0);
  });

  it('writes the repair marker only after a run without errors', async () => {
    const unreadable = path.join(projectsDir, '-w-go-llm-agent', 'broken-0001.jsonl');
    fs.writeFileSync(unreadable, 'x\n');
    fs.chmodSync(unreadable, 0o000);

    const failing = await recoverTranscripts(configPath, projectsDir);
    expect(failing.errors).toBe(1);
    expect(fs.existsSync(marker())).toBe(false);

    fs.chmodSync(unreadable, 0o600);
    await recoverTranscripts(configPath, projectsDir);
    expect(fs.existsSync(marker())).toBe(true);
  });

  it('leaves a session with a pending prompt to the hooks', async () => {
    await importThenCorrupt({ createdAt: '2026-10-17T00:31:43.000Z' });
    writePendingPrompt(tmpDir, {
      version: 2,
      runtime: 'claude',
      sessionId: SID,
      projectPath: CWD,
      prompt: 'live',
      source: {},
      pendingKey: 'pk-1',
      turnSequence: 1,
      sourceOrder: '00000000000000000003',
      createdAt: '2026-09-02T00:00:00Z',
    });

    expect((await recoverTranscripts(configPath, projectsDir)).repaired).toBe(0);
  });

  it('does not repair a session with a deleted chunk, so the deleted text stays out', async () => {
    await importThenCorrupt({ createdAt: '2026-10-17T00:31:43.000Z' });
    recordChunkDeletion(
      deletionsFile(dbPath),
      '[User]\nfirst question\n\n[Assistant]\nfirst answer'
    );

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.repaired).toBe(0);
    expect(all<{ turn_key: string | null }>('SELECT turn_key FROM chunks')).toEqual([
      { turn_key: null },
    ]);
  });

  it('does not repair when only one of several chunks was deleted', async () => {
    fs.appendFileSync(
      file,
      [
        line('user', 'second question', '2026-09-01T00:02:00Z'),
        line('assistant', 'second answer', '2026-09-01T00:03:00Z'),
      ].join('\n') + '\n'
    );
    await importThenCorrupt({ createdAt: '2026-10-17T00:31:43.000Z' });
    recordChunkDeletion(
      deletionsFile(dbPath),
      '[User]\nfirst question\n\n[Assistant]\nfirst answer'
    );

    expect((await recoverTranscripts(configPath, projectsDir)).repaired).toBe(0);
    expect(all<{ turn_key: string | null }>('SELECT turn_key FROM chunks')).toEqual([
      { turn_key: null },
      { turn_key: null },
    ]);
  });

  it('leaves a session without any answered turn untouched', async () => {
    fs.writeFileSync(file, line('user', 'unanswered', '2026-09-01T00:00:00Z') + '\n');
    await importThenCorrupt({ createdAt: '2026-10-17T00:31:43.000Z' });

    expect((await recoverTranscripts(configPath, projectsDir)).repaired).toBe(0);
    expect(all<{ turn_key: string | null }>('SELECT turn_key FROM chunks')).toEqual([
      { turn_key: null },
    ]);
  });

  it('does not repair a hook-managed session only because its project path differs', async () => {
    await importThenCorrupt();
    sql('UPDATE chunks SET turn_key = ?, project_path = ?', 'tk-hook', '/elsewhere');
    sql('UPDATE sessions SET project_path = ?', '/elsewhere');

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.repaired).toBe(0);
    expect(all('SELECT turn_key, project_path FROM chunks')).toEqual([
      { turn_key: 'tk-hook', project_path: '/elsewhere' },
    ]);
  });

  it('does not repair a session saved by the Stop hook, even when its keys follow the offset rule', async () => {
    const dirA = path.join(tmpDir, 'A');
    const dirB = path.join(tmpDir, 'B');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const now = new Date().toISOString();
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'user',
          sessionId: SID,
          cwd: dirA,
          timestamp: now,
          message: { role: 'user', content: 'q1' },
        }),
        line('assistant', 'a1', now),
      ].join('\n') + '\n'
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        database: { path: dbPath },
        storage: { jsonlDir, transcriptArchiveDir: path.join(tmpDir, 'archive') },
        maintenance: { enabled: false },
      })
    );
    await checkpointStop(
      'claude',
      JSON.stringify({
        hook_event_name: 'Stop',
        session_id: SID,
        transcript_path: file,
        cwd: dirB,
      }),
      configPath
    );
    const before = all<{ project_path: string; turn_key: string | null }>(
      'SELECT project_path, turn_key FROM chunks'
    );
    expect(before.map((r) => r.project_path)).toEqual([fs.realpathSync(dirB)]);
    expect(before[0].turn_key).not.toBeNull();

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.repaired).toBe(0);
    expect(all('SELECT project_path, turn_key FROM chunks')).toEqual(before);
  });

  it('does not repair a session that already aged out of retention', async () => {
    const old = new Date();
    old.setDate(old.getDate() - 120);
    fs.writeFileSync(
      file,
      [
        line('user', 'old question', old.toISOString()),
        line('assistant', 'old answer', old.toISOString()),
      ].join('\n') + '\n'
    );
    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);
    store.insertSession({
      sessionId: SID,
      projectPath: WRONG,
      startedAt: old.toISOString(),
      endedAt: old.toISOString(),
    });
    db.close();

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.repaired).toBe(0);
    expect(all('SELECT project_path FROM sessions')).toEqual([{ project_path: WRONG }]);
  });

  it('stamps chunks of a transcript without valid timestamps with the file mtime', async () => {
    const mtime = new Date(Date.now() - 10 * 86400000);
    mtime.setMilliseconds(0);
    fs.writeFileSync(
      file,
      [line('user', 'q', 'zzz-not-a-date'), line('assistant', 'a', 'zzz-not-a-date')].join('\n') +
        '\n'
    );
    fs.utimesSync(file, mtime, mtime);

    await recoverTranscripts(configPath, projectsDir);

    expect(all('SELECT created_at FROM chunks')).toEqual([{ created_at: mtime.toISOString() }]);
  });

  it('does not import an untimed transcript whose file is older than the retention window', async () => {
    const mtime = new Date(Date.now() - 120 * 86400000);
    fs.writeFileSync(file, [line('user', 'q'), line('assistant', 'a')].join('\n') + '\n');
    fs.utimesSync(file, mtime, mtime);

    const result = await recoverTranscripts(configPath, projectsDir);

    expect(result.recovered).toBe(0);
    expect(all('SELECT * FROM sessions')).toEqual([]);
  });

  it('clamps a future file mtime when stamping untimed chunks and the session row', async () => {
    const future = new Date(Date.now() + 3650 * 86400000);
    fs.writeFileSync(file, [line('user', 'q'), line('assistant', 'a')].join('\n') + '\n');
    fs.utimesSync(file, future, future);

    await recoverTranscripts(configPath, projectsDir);

    const limit = Date.now() + 86400000;
    const [chunk] = all<{ created_at: string }>('SELECT created_at FROM chunks');
    const [session] = all<{ started_at: string; ended_at: string }>(
      'SELECT started_at, ended_at FROM sessions'
    );
    for (const value of [chunk.created_at, session.started_at, session.ended_at]) {
      expect(Date.parse(value)).toBeLessThanOrEqual(limit);
      expect(Date.parse(value)).toBeGreaterThan(limit - 60000);
    }
  });

  it('records the file mtime as the session time when the transcript has no timestamps', async () => {
    const mtime = new Date(Date.now() - 10 * 86400000);
    mtime.setMilliseconds(0);
    fs.writeFileSync(file, [line('user', 'q'), line('assistant', 'a')].join('\n') + '\n');
    fs.utimesSync(file, mtime, mtime);

    await recoverTranscripts(configPath, projectsDir);

    expect(all('SELECT started_at, ended_at FROM sessions')).toEqual([
      { started_at: mtime.toISOString(), ended_at: mtime.toISOString() },
    ]);
  });

  it('keeps the transcript timestamps for the session row when they exist', async () => {
    await recoverTranscripts(configPath, projectsDir);

    expect(all('SELECT started_at, ended_at FROM sessions')).toEqual([
      { started_at: '2026-09-01T00:00:00Z', ended_at: '2026-09-01T00:01:00Z' },
    ]);
  });

  it('uses the file mtime for untimed turns when a grown session is refreshed', async () => {
    fs.writeFileSync(file, [line('user', 'q1'), line('assistant', 'a1')].join('\n') + '\n');
    await recoverTranscripts(configPath, projectsDir);
    const mtime = new Date(Date.now() - 5 * 86400000);
    mtime.setMilliseconds(0);
    fs.appendFileSync(file, [line('user', 'q2'), line('assistant', 'a2')].join('\n') + '\n');
    fs.utimesSync(file, mtime, mtime);

    await recoverTranscripts(configPath, projectsDir);

    expect(
      all<{ created_at: string }>('SELECT created_at FROM chunks ORDER BY id').map(
        (r) => r.created_at
      )
    ).toEqual([mtime.toISOString(), mtime.toISOString()]);
  });

  it('stamps a turn without timestamps with the last conversation time, not the import time', async () => {
    await recoverTranscripts(configPath, projectsDir);
    fs.appendFileSync(
      file,
      [line('user', 'untimed question'), line('assistant', 'untimed answer')].join('\n') + '\n'
    );

    await recoverTranscripts(configPath, projectsDir);

    expect(
      all<{ created_at: string }>('SELECT created_at FROM chunks ORDER BY id').map(
        (r) => r.created_at
      )
    ).toEqual(['2026-09-01T00:01:00Z', '2026-09-01T00:01:00Z']);
  });

  it('resolves a symlinked cwd to the real path, like the save hook', async () => {
    const real = path.join(tmpDir, 'real-proj');
    const link = path.join(tmpDir, 'link-proj');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    fs.writeFileSync(
      file,
      [
        line('user', 'q', '2026-09-01T00:00:00Z').replace(CWD, link),
        line('assistant', 'a', '2026-09-01T00:01:00Z'),
      ].join('\n') + '\n'
    );

    await recoverTranscripts(configPath, projectsDir);

    expect(all('SELECT project_path FROM sessions')).toEqual([
      { project_path: fs.realpathSync(real) },
    ]);
  });
});
