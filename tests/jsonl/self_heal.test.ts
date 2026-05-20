import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { JsonlWriter } from '@/jsonl/writer';
import { selfHealFromJsonl } from '@/jsonl/self_heal';
import type { JsonlChunkRecord } from '@/jsonl/types';
import { randomUUID } from 'node:crypto';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-selfheal-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeRecord(id: string, idx: number): JsonlChunkRecord {
  return {
    v: 1,
    type: 'chunk',
    id,
    sessionId: 'sess-1',
    projectPath: '/tmp/proj',
    chunkIndex: idx,
    content: `content-${idx}`,
    role: 'human',
    metadata: JSON.stringify({ filePaths: [], toolNames: [], errorMessages: [] }),
    tokenCount: 10,
    createdAt: new Date(Date.UTC(2026, 4, 21, idx)).toISOString(),
  };
}

describe('selfHealFromJsonl', () => {
  it('reinserts JSONL records missing from SQLite', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'memory.db');
    const db = new Database(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    // 3 records to JSONL, only 1 inserted to SQLite (simulating SQLite-side loss)
    const writer = new JsonlWriter(dir);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const records = ids.map((id, i) => makeRecord(id, i));
    writer.appendRecords(records, new Date(Date.UTC(2026, 4, 21)));

    // 1件だけ SQLite に入っている状態を作る
    store.insertChunks([
      {
        externalId: ids[0],
        sessionId: 'sess-1',
        projectPath: '/tmp/proj',
        chunkIndex: 0,
        content: 'content-0',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 10,
      },
    ]);

    const result = selfHealFromJsonl(store, dir, 100);
    expect(result.scanned).toBe(3);
    expect(result.reinserted).toBe(2);

    // Now all 3 should be present
    const missing = store.findMissingExternalIds(ids);
    expect(missing).toEqual([]);
    db.close();
  });

  it('no-op when SQLite has everything', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'memory.db');
    const db = new Database(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    const id = randomUUID();
    const writer = new JsonlWriter(dir);
    writer.appendRecords([makeRecord(id, 0)], new Date(Date.UTC(2026, 4, 21)));
    store.insertChunks([
      {
        externalId: id,
        sessionId: 'sess-1',
        projectPath: '/tmp/proj',
        chunkIndex: 0,
        content: 'content-0',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 10,
      },
    ]);

    const result = selfHealFromJsonl(store, dir, 100);
    expect(result.reinserted).toBe(0);
    db.close();
  });

  it('returns 0 when no JSONL files exist', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'memory.db');
    const db = new Database(dbPath);
    initializeSchema(db);
    const store = new Store(db);

    const result = selfHealFromJsonl(store, dir, 100);
    expect(result.scanned).toBe(0);
    expect(result.reinserted).toBe(0);
    db.close();
  });
});
