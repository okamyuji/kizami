import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { getDatabase } from '../src/db/connection';

describe('connection', () => {
  const tmpDirs: string[] = [];

  function makeTmpDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-conn-'));
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
    const dbPath = path.join(os.tmpdir(), `engram-conn-${Date.now()}`, 'nested', 'test.db');
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
});
