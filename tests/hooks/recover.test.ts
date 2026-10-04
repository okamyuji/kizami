import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
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

  const fixtureTranscript = path.resolve(__dirname, '../fixtures/sample-transcript.jsonl');

  it('should recover unsaved transcript files', async () => {
    // フェイクプロジェクトディレクトリにトランスクリプトを配置
    const projectDir = path.join(fakeProjectsDir, '-tmp-testproject');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.copyFileSync(fixtureTranscript, path.join(projectDir, 'unsaved-session-1.jsonl'));

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
    fs.copyFileSync(fixtureTranscript, path.join(projectDir, 'aliased-session.jsonl'));

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
    fs.copyFileSync(fixtureTranscript, path.join(projectDir, 'unaliased-session.jsonl'));

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
    fs.copyFileSync(fixtureTranscript, path.join(projectDir, 'deleted-session-1.jsonl'));
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
    fs.copyFileSync(fixtureTranscript, path.join(projectDir, 'already-saved.jsonl'));

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

    fs.copyFileSync(fixtureTranscript, path.join(projectDir1, 'session-a.jsonl'));
    fs.copyFileSync(fixtureTranscript, path.join(projectDir2, 'session-b.jsonl'));

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
    fs.copyFileSync(fixtureTranscript, path.join(projectDir, 'path-test-session.jsonl'));

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
    fs.copyFileSync(fixtureTranscript, path.join(projectDir, 'idempotent-session.jsonl'));

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
