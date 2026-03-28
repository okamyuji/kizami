import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { getDatabase } from '../src/db/connection';
import { initializeSchema } from '../src/db/schema';

describe('schema', () => {
  const tmpDirs: string[] = [];

  function makeDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-schema-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    return getDatabase(dbPath);
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('should create all tables', () => {
    const db = makeDb();
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('chunks');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('schema_version');
    db.close();
  });

  it('should create FTS5 virtual table', () => {
    const db = makeDb();
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'")
      .all() as { name: string }[];
    expect(tables.length).toBe(1);
    db.close();
  });

  it('should create triggers', () => {
    const db = makeDb();
    initializeSchema(db);

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as { name: string }[];
    const triggerNames = triggers.map((t) => t.name);

    expect(triggerNames).toContain('chunks_ai');
    expect(triggerNames).toContain('chunks_ad');
    expect(triggerNames).toContain('chunks_au');
    db.close();
  });

  it('should set schema version', () => {
    const db = makeDb();
    initializeSchema(db);

    const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as {
      version: number;
    };
    expect(row.version).toBe(1);
    db.close();
  });

  it('should be idempotent', () => {
    const db = makeDb();
    initializeSchema(db);
    initializeSchema(db); // Should not throw
    const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as {
      version: number;
    };
    expect(row.version).toBe(1);
    db.close();
  });
});
