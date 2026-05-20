import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { migrateSqliteToJsonl } from '@/jsonl/migrate';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { getDefaultConfig } from '@/config';
import { listJsonlFiles } from '@/jsonl/path';
import { readJsonlFile } from '@/jsonl/reader';
import type { EngramConfig } from '@/config';
import type { JsonlChunkRecord } from '@/jsonl/types';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-migrate-'));
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

describe('migrateSqliteToJsonl', () => {
  it('exports legacy SQLite chunks to JSONL with new external_ids', async () => {
    const dir = makeTmpDir();
    const config = makeTestConfig(dir);

    // legacy SQLite (no external_id) を作成
    const db = getDatabase(config.database.path);
    initializeSchema(db);
    const store = new Store(db);
    store.insertChunks([
      {
        sessionId: 'sess-1',
        projectPath: '/tmp/proj',
        chunkIndex: 0,
        content: 'hello',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 5,
      },
      {
        sessionId: 'sess-1',
        projectPath: '/tmp/proj',
        chunkIndex: 1,
        content: 'world',
        role: 'assistant',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 5,
      },
    ]);
    db.close();

    const result = migrateSqliteToJsonl(config);
    expect(result.totalChunks).toBe(2);
    expect(result.exported).toBe(2);
    expect(result.alreadyMigrated).toBe(0);

    // JSONL に2行書かれているはず
    const files = listJsonlFiles(config.storage.jsonlDir);
    expect(files.length).toBeGreaterThanOrEqual(1);

    const collected: JsonlChunkRecord[] = [];
    for (const f of files) {
      for await (const rec of readJsonlFile(f)) {
        collected.push(rec);
      }
    }
    expect(collected.length).toBe(2);
    // external_id は SQLite 側にも書き戻されているはず
    const db2 = getDatabase(config.database.path);
    initializeSchema(db2);
    const store2 = new Store(db2);
    const ids = collected.map((r) => r.id);
    expect(store2.findMissingExternalIds(ids)).toEqual([]);
    db2.close();
  });

  it('handles empty SQLite gracefully', () => {
    const dir = makeTmpDir();
    const config = makeTestConfig(dir);
    const db = getDatabase(config.database.path);
    initializeSchema(db);
    db.close();
    const result = migrateSqliteToJsonl(config);
    expect(result.totalChunks).toBe(0);
    expect(result.exported).toBe(0);
  });
});
