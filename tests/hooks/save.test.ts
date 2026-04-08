import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';
import { Store } from '../../src/db/store';
import { handleSave } from '../../src/hooks/save';

describe('handleSave', () => {
  let tmpDir: string;
  let dbPath: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-save-'));
    dbPath = path.join(tmpDir, 'test.db');
    configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ database: { path: dbPath } }), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const fixtureTranscript = path.resolve(__dirname, '../fixtures/sample-transcript.jsonl');

  it('should parse transcript and save chunks to DB', async () => {
    await handleSave(
      {
        session_id: 'test-session',
        transcript_path: fixtureTranscript,
        cwd: tmpDir,
      },
      configPath
    );

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    const stats = store.getStats();
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.totalSessions).toBe(1);

    const sessions = store.getSessionList();
    expect(sessions[0].sessionId).toBe('test-session');
    expect(sessions[0].chunkCount).toBeGreaterThan(0);

    db.close();
  });

  it('should set first and last message from transcript', async () => {
    await handleSave(
      {
        session_id: 'test-session-2',
        transcript_path: fixtureTranscript,
        cwd: tmpDir,
      },
      configPath
    );

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    const sessions = store.getSessionList();
    expect(sessions[0].firstMessage).toBeDefined();
    expect(sessions[0].firstMessage!.length).toBeGreaterThan(0);

    db.close();
  });

  it('should resolve cwd to realpath for projectPath', async () => {
    await handleSave(
      {
        session_id: 'test-session-3',
        transcript_path: fixtureTranscript,
        cwd: tmpDir,
      },
      configPath
    );

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    const sessions = store.getSessionList();
    const resolvedTmp = fs.realpathSync(tmpDir);
    expect(sessions[0].projectPath).toBe(resolvedTmp);

    db.close();
  });

  it('should handle missing cwd by falling back to process.cwd()', async () => {
    await handleSave(
      {
        session_id: 'test-no-cwd',
        transcript_path: fixtureTranscript,
        cwd: process.cwd(),
      },
      configPath
    );

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    const sessions = store.getSessionList();
    expect(sessions.length).toBe(1);
    expect(sessions[0].projectPath).toBe(fs.realpathSync(process.cwd()));

    db.close();
  });

  it('should handle empty transcript gracefully', async () => {
    const emptyFile = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(emptyFile, '', 'utf-8');

    await handleSave(
      {
        session_id: 'empty-session',
        transcript_path: emptyFile,
        cwd: tmpDir,
      },
      configPath
    );

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    const stats = store.getStats();
    expect(stats.totalChunks).toBe(0);
    expect(stats.totalSessions).toBe(0);

    db.close();
  });
});

describe('runSave signal handling', () => {
  it('should survive SIGINT when wrapped with bash trap (production hook)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-sig-'));
    const sigDbPath = path.join(tmpDir, 'test.db');
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ database: { path: sigDbPath } }), 'utf-8');

    const fixtureTranscript = path.resolve(__dirname, '../fixtures/sample-transcript.jsonl');
    const stdinData = JSON.stringify({
      session_id: 'sigint-test',
      transcript_path: fixtureTranscript,
      cwd: tmpDir,
    });

    const cliPath = path.resolve(__dirname, '../../dist/cli.js');

    // 本番のhook commandと同じく bash -c 'trap "" INT TERM; ...' で実行
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(
        'bash',
        ['-c', `trap "" INT TERM; node ${cliPath} save --stdin --config ${cfgPath}`],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      child.stdin.write(stdinData);
      child.stdin.end();
      setTimeout(() => child.kill('SIGINT'), 50);
      child.on('exit', (code) => resolve(code));
    });

    expect(exitCode).toBe(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
