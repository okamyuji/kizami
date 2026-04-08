import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';
import { Store } from '../../src/db/store';
import { recoverTranscripts, projectDirToPath } from '../../src/hooks/recover';

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
  let configPath: string;
  let fakeProjectsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-recover-'));
    dbPath = path.join(tmpDir, 'test.db');
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ database: { path: dbPath } }), 'utf-8');

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
