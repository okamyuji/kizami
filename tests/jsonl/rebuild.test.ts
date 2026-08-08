import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { rebuildFromJsonl } from '@/jsonl/rebuild';
import { JsonlWriter } from '@/jsonl/writer';
import { getDefaultConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';
import type { JsonlChunkRecord } from '@/jsonl/types';
import type { EngramConfig } from '@/config';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-rebuild-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeTestConfig(dir: string): EngramConfig {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    database: { path: path.join(dir, 'memory.db') },
    storage: { ...defaults.storage, jsonlDir: path.join(dir, 'jsonl') },
  };
}

function makeRec(id: string, idx: number, sess: string = 'sess-1'): JsonlChunkRecord {
  return {
    v: 1,
    type: 'chunk',
    id,
    sessionId: sess,
    projectPath: '/tmp/proj',
    chunkIndex: idx,
    content: `body-${idx}`,
    role: 'human',
    metadata: JSON.stringify({ filePaths: [], toolNames: [], errorMessages: [] }),
    tokenCount: 8,
    createdAt: new Date(Date.UTC(2026, 4, 21, idx % 24)).toISOString(),
  };
}

describe('rebuildFromJsonl', () => {
  it('rejects --from-month without dry-run before opening the database', async () => {
    const dir = makeTmpDir();
    const config = makeTestConfig(dir);
    await expect(rebuildFromJsonl(config, { fromMonth: '2026-05' })).rejects.toThrow(
      '--from-month is only supported with --dry-run'
    );
    expect(fs.existsSync(config.database.path)).toBe(false);
  });

  it('does not modify existing SQLite data when JSONL validation is fatal', async () => {
    const dir = makeTmpDir();
    const config = makeTestConfig(dir);
    fs.mkdirSync(config.storage.jsonlDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(config.storage.jsonlDir, '2026-05-host.jsonl'),
      '{invalid}\n{also-invalid}\n'
    );
    const db = getDatabase(config.database.path);
    initializeSchema(db);
    const store = new Store(db);
    store.insertChunks([
      {
        sessionId: 'existing',
        projectPath: '/tmp',
        chunkIndex: 0,
        content: 'preserve me',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 2,
      },
    ]);
    db.close();

    await expect(rebuildFromJsonl(config)).rejects.toThrow(
      'Rebuild validation failed: invalid JSON; invalid JSON'
    );
    const after = getDatabase(config.database.path);
    initializeSchema(after);
    expect(new Store(after).getStats().totalChunks).toBe(1);
    after.close();
  });
  it('reconstructs SQLite chunks from JSONL', async () => {
    const dir = makeTmpDir();
    const config = makeTestConfig(dir);
    fs.mkdirSync(config.storage.jsonlDir, { recursive: true, mode: 0o700 });

    const writer = new JsonlWriter(config.storage.jsonlDir);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    writer.appendRecords(
      ids.map((id, i) => makeRec(id, i)),
      new Date(Date.UTC(2026, 4, 21))
    );

    const result = await rebuildFromJsonl(config);
    expect(result.filesProcessed).toBe(1);
    expect(result.chunksInserted).toBe(3);
    expect(result.dryRun).toBe(false);

    // SQLite を直接確認
    const db = getDatabase(config.database.path);
    initializeSchema(db);
    const store = new Store(db);
    const stats = store.getStats();
    expect(stats.totalChunks).toBe(3);
    expect(stats.totalSessions).toBe(1);
    db.close();
  });

  it('dryRun does not write to SQLite', async () => {
    const dir = makeTmpDir();
    const config = makeTestConfig(dir);
    fs.mkdirSync(config.storage.jsonlDir, { recursive: true, mode: 0o700 });

    const writer = new JsonlWriter(config.storage.jsonlDir);
    writer.appendRecords([makeRec(randomUUID(), 0)], new Date(Date.UTC(2026, 4, 21)));

    const result = await rebuildFromJsonl(config, { dryRun: true });
    expect(result.chunksInserted).toBe(1);
    expect(result.dryRun).toBe(true);

    const db = getDatabase(config.database.path);
    initializeSchema(db);
    const store = new Store(db);
    expect(store.getStats().totalChunks).toBe(0);
    db.close();
  });

  it('is idempotent: re-running gives same row count', async () => {
    const dir = makeTmpDir();
    const config = makeTestConfig(dir);
    fs.mkdirSync(config.storage.jsonlDir, { recursive: true, mode: 0o700 });

    const writer = new JsonlWriter(config.storage.jsonlDir);
    writer.appendRecords(
      [makeRec(randomUUID(), 0), makeRec(randomUUID(), 1)],
      new Date(Date.UTC(2026, 4, 21))
    );

    await rebuildFromJsonl(config);
    await rebuildFromJsonl(config);

    const db = getDatabase(config.database.path);
    initializeSchema(db);
    const store = new Store(db);
    expect(store.getStats().totalChunks).toBe(2);
    db.close();
  });
});
