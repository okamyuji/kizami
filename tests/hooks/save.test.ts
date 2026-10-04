import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';
import { Store } from '../../src/db/store';
import { handleSave, archiveHookTranscript } from '../../src/hooks/save';

describe('handleSave', () => {
  let tmpDir: string;
  let dbPath: string;
  let configPath: string;
  let previousJsonlDir: string | undefined;
  let previousArchiveDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-save-'));
    dbPath = path.join(tmpDir, 'test.db');
    configPath = path.join(tmpDir, 'config.json');
    previousJsonlDir = process.env.KIZAMI_JSONL_DIR;
    process.env.KIZAMI_JSONL_DIR = path.join(tmpDir, 'jsonl');
    previousArchiveDir = process.env.KIZAMI_TRANSCRIPT_ARCHIVE_DIR;
    process.env.KIZAMI_TRANSCRIPT_ARCHIVE_DIR = path.join(tmpDir, 'archive');
    fs.writeFileSync(configPath, JSON.stringify({ database: { path: dbPath } }), 'utf-8');
  });

  afterEach(() => {
    if (previousArchiveDir === undefined) {
      delete process.env.KIZAMI_TRANSCRIPT_ARCHIVE_DIR;
    } else {
      process.env.KIZAMI_TRANSCRIPT_ARCHIVE_DIR = previousArchiveDir;
    }
    if (previousJsonlDir === undefined) {
      delete process.env.KIZAMI_JSONL_DIR;
    } else {
      process.env.KIZAMI_JSONL_DIR = previousJsonlDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const fixtureTranscript = path.resolve(__dirname, '../fixtures/sample-transcript.jsonl');

  it('still stores chunks when archiving fails', async () => {
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    process.env.KIZAMI_TRANSCRIPT_ARCHIVE_DIR = path.join(blocker, 'archive');
    const projDir = path.join(tmpDir, 'projects', '-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const transcript = path.join(projDir, 'ffff6666.jsonl');
    fs.copyFileSync(fixtureTranscript, transcript);

    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await handleSave(
        { session_id: 'ffff6666', transcript_path: transcript, cwd: tmpDir },
        configPath
      );
      expect(spy.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringMatching(/^kizami archive error \(skipped\): .*ENOTDIR/)
      );
    } finally {
      spy.mockRestore();
    }

    const db = getDatabase(dbPath);
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?').get('ffff6666') as {
        n: number;
      }
    ).n;
    db.close();
    expect(count).toBeGreaterThan(0);
  });

  it('archives the transcript named by a claude hook payload', () => {
    const projDir = path.join(tmpDir, 'projects', '-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const transcript = path.join(projDir, 'dddd4444.jsonl');
    fs.copyFileSync(fixtureTranscript, transcript);

    archiveHookTranscript(JSON.stringify({ transcript_path: transcript }), 'claude', configPath);

    expect(fs.existsSync(path.join(tmpDir, 'archive', '-proj', 'dddd4444.jsonl'))).toBe(true);
  });

  it('does not archive for other runtimes or when the payload names no existing file', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const projDir = path.join(tmpDir, 'projects', '-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const transcript = path.join(projDir, 'eeee5555.jsonl');
    fs.copyFileSync(fixtureTranscript, transcript);

    archiveHookTranscript(JSON.stringify({ transcript_path: transcript }), 'codex', configPath);
    archiveHookTranscript(JSON.stringify({ transcript_path: 42 }), 'claude', configPath);
    archiveHookTranscript(
      JSON.stringify({ transcript_path: path.join(projDir, 'missing.jsonl') }),
      'claude',
      configPath
    );

    expect(fs.existsSync(path.join(tmpDir, 'archive'))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reports an archive failure on stderr without throwing', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => archiveHookTranscript('not json', 'claude', configPath)).not.toThrow();
      expect(spy.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringMatching(/^kizami archive error \(skipped\): SyntaxError/)
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('archives the raw transcript before chunking', async () => {
    const projDir = path.join(tmpDir, 'projects', '-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const transcript = path.join(projDir, 'cccc3333.jsonl');
    fs.copyFileSync(fixtureTranscript, transcript);

    await handleSave(
      { session_id: 'cccc3333', transcript_path: transcript, cwd: tmpDir },
      configPath
    );

    expect(fs.existsSync(path.join(tmpDir, 'archive', '-proj', 'cccc3333.jsonl'))).toBe(true);
  });

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

  it('should map projectPath through storage.projectAliases when configured', async () => {
    const resolvedTmp = fs.realpathSync(tmpDir);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        database: { path: dbPath },
        storage: { projectAliases: { [resolvedTmp]: '/shared/project' } },
      }),
      'utf-8'
    );

    await handleSave(
      {
        session_id: 'test-session-alias',
        transcript_path: fixtureTranscript,
        cwd: tmpDir,
      },
      configPath
    );

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    const sessions = store.getSessionList();
    expect(sessions[0].projectPath).toBe('/shared/project');

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

  it('transcript ファイルが存在しない場合は silently skip して保存しない', async () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.jsonl');

    await expect(
      handleSave(
        {
          session_id: 'missing-session',
          transcript_path: missingPath,
          cwd: tmpDir,
        },
        configPath
      )
    ).resolves.toBeUndefined();

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    const stats = store.getStats();
    expect(stats.totalChunks).toBe(0);
    expect(stats.totalSessions).toBe(0);

    db.close();
  });

  it('同一 session_id で 2 回保存しても UNIQUE 違反を起こさない', async () => {
    await handleSave(
      { session_id: 'reentry', transcript_path: fixtureTranscript, cwd: tmpDir },
      configPath
    );

    await expect(
      handleSave(
        { session_id: 'reentry', transcript_path: fixtureTranscript, cwd: tmpDir },
        configPath
      )
    ).resolves.toBeUndefined();

    const db = getDatabase(dbPath);
    initializeSchema(db);
    const store = new Store(db);
    const sessions = store.getSessionList();
    expect(sessions.filter((s) => s.sessionId === 'reentry')).toHaveLength(1);
    db.close();
  });
});

describe('runSave archiving', () => {
  it('archives the transcript when the save hook runs for claude', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-runsave-'));
    try {
      const cfgPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          database: { path: path.join(tmpDir, 'test.db') },
          storage: {
            jsonlDir: path.join(tmpDir, 'jsonl'),
            transcriptArchiveDir: path.join(tmpDir, 'archive'),
          },
        })
      );
      const projDir = path.join(tmpDir, 'projects', '-proj');
      fs.mkdirSync(projDir, { recursive: true });
      const transcript = path.join(projDir, 'abab1212.jsonl');
      fs.copyFileSync(path.resolve(__dirname, '../fixtures/sample-transcript.jsonl'), transcript);
      const env = { ...process.env };
      delete env.KIZAMI_TRANSCRIPT_ARCHIVE_DIR;
      delete env.KIZAMI_JSONL_DIR;

      const result = spawnSync(
        process.execPath,
        ['dist/cli.js', 'save', '--stdin', '--runtime', 'claude', '--config', cfgPath],
        {
          cwd: path.resolve(__dirname, '../..'),
          env,
          input: JSON.stringify({
            session_id: 'abab1212',
            transcript_path: transcript,
            cwd: tmpDir,
            hook_event_name: 'Stop',
          }),
        }
      );

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, 'archive', '-proj', 'abab1212.jsonl'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('runSave signal handling', () => {
  it('should survive SIGINT when wrapped with bash trap (production hook)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-sig-'));
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ database: { path: path.join(tmpDir, 'test.db') } }),
      'utf-8'
    );

    const fixtureTranscript = path.resolve(__dirname, '../fixtures/sample-transcript.jsonl');
    const stdinData = JSON.stringify({
      session_id: 'sigint-test',
      transcript_path: fixtureTranscript,
      cwd: tmpDir,
    });

    // process.execPathとcwdオプションを使い、シェルを経由せず直接起動する
    const projectRoot = path.resolve(__dirname, '../..');
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(
        process.execPath,
        ['dist/cli.js', 'save', '--stdin', '--config', cfgPath],
        {
          cwd: projectRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      child.stdin.write(stdinData);
      child.stdin.end();
      // node プロセス起動 (spawn イベント) を待ってから SIGINT を送る。
      // cli.ts トップレベルの SIGINT ハンドラ登録が走るまで猶予が要るため、
      // CPU 負荷時の取りこぼし防止に十分なディレイ (500ms) を入れる。
      child.once('spawn', () => {
        setTimeout(() => child.kill('SIGINT'), 500);
      });
      child.on('exit', (code) => resolve(code));
    });

    expect(exitCode).toBe(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
