import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getDatabase } from '../src/db/connection';
import { JsonlTransactionWriter } from '../src/jsonl/writer';

describe('connection', () => {
  const tmpDirs: string[] = [];

  function makeTmpDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-conn-'));
    tmpDirs.push(dir);
    return path.join(dir, 'test.db');
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('should create database file and parent directories', () => {
    const dbPath = path.join(os.tmpdir(), `kizami-conn-${Date.now()}`, 'nested', 'test.db');
    const db = getDatabase(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    db.close();
    fs.rmSync(path.dirname(path.dirname(dbPath)), { recursive: true, force: true });
  });

  it('should enable WAL mode', () => {
    const dbPath = makeTmpDb();
    const db = getDatabase(dbPath);
    const result = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe('wal');
    db.close();
  });

  it('should return a functional database instance', () => {
    const dbPath = makeTmpDb();
    const db = getDatabase(dbPath);
    db.prepare('CREATE TABLE test (id INTEGER PRIMARY KEY)').run();
    db.prepare('INSERT INTO test (id) VALUES (?)').run(1);
    const row = db.prepare('SELECT id FROM test').get() as { id: number };
    expect(row.id).toBe(1);
    db.close();
  });

  it.skipIf(process.platform === 'win32')('rejects a database symlink before opening it', () => {
    const dbPath = makeTmpDb();
    const targetPath = path.join(path.dirname(dbPath), 'outside.db');
    fs.writeFileSync(targetPath, 'unchanged');
    fs.symlinkSync(targetPath, dbPath);

    expect(() => getDatabase(dbPath)).toThrow(/symlink/);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('unchanged');
  });

  // 別のプロセスが接続を開いて閉じる。そのプロセスは、自分が最後の接続だと判断すると -shm と WAL を消す
  const openAndCloseElsewhere = (dbPath: string) => {
    const script = `const D = require('better-sqlite3'); const d = new D(process.argv[1]);
      d.pragma('journal_mode = WAL'); d.prepare('select 1').get(); d.close();`;
    const r = spawnSync(process.execPath, ['-e', script, dbPath], { encoding: 'utf-8' });
    expect(r.stderr).toBe('');
  };

  it.skipIf(process.platform === 'win32')(
    'keeps the locks of a connection already open in the process when it opens another one',
    () => {
      const dbPath = makeTmpDb();
      const first = getDatabase(dbPath);
      first.exec('CREATE TABLE t (x TEXT)');
      const insert = first.prepare('INSERT INTO t VALUES (?)');
      for (let i = 0; i < 100; i++) insert.run(`row ${i}`);

      getDatabase(dbPath).close();
      openAndCloseElsewhere(dbPath);

      expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);
      expect(first.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 100 });
      first.close();
    }
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the locks of the JSONL writer lock when another writer opens in the process',
    () => {
      const dir = path.dirname(makeTmpDb());
      const first = new JsonlTransactionWriter(dir);
      const second = new JsonlTransactionWriter(dir);
      second.close();

      openAndCloseElsewhere(path.join(dir, '.writer-lock.sqlite'));

      expect(fs.existsSync(path.join(dir, '.writer-lock.sqlite-shm'))).toBe(true);
      first.close();
    }
  );

  it.skipIf(process.platform === 'win32')(
    'gives the JSONL writer lock files to the owner only',
    () => {
      const dir = path.dirname(makeTmpDb());
      const first = new JsonlTransactionWriter(dir);
      const files = ['', '-wal', '-shm'].map((s) => path.join(dir, `.writer-lock.sqlite${s}`));
      for (const f of files) fs.chmodSync(f, 0o644);

      new JsonlTransactionWriter(dir).close();

      for (const f of files) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      first.close();
    }
  );

  it.skipIf(process.platform === 'win32')(
    'still gives the database files to the owner only',
    () => {
      const dbPath = makeTmpDb();
      const db = getDatabase(dbPath);
      db.exec('CREATE TABLE t (x TEXT)');
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.chmodSync(f, 0o644);
      getDatabase(dbPath).close();
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      }
      db.close();
    }
  );
});
