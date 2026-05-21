import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { rebuildFromJsonl } from '@/jsonl/rebuild';
import { JsonlWriter } from '@/jsonl/writer';
import { getDefaultConfig } from '@/config';
import type { EngramConfig } from '@/config';
import type { JsonlChunkRecord } from '@/jsonl/types';
import { initializeSchema } from '@/db/schema';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-rebuild-vec0-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeRec(id: string, idx: number): JsonlChunkRecord {
  return {
    v: 1,
    type: 'chunk',
    id,
    sessionId: 'sess-1',
    projectPath: '/tmp/proj',
    chunkIndex: idx,
    content: `body-${idx}`,
    role: 'human',
    metadata: JSON.stringify({ filePaths: [], toolNames: [], errorMessages: [] }),
    tokenCount: 8,
    createdAt: new Date(Date.UTC(2026, 4, 21, idx % 24)).toISOString(),
  };
}

function makeTestConfig(dir: string, mode: 'core' | 'hybrid' = 'core'): EngramConfig {
  const d = getDefaultConfig();
  return {
    ...d,
    database: { path: path.join(dir, 'memory.db') },
    storage: { ...d.storage, jsonlDir: path.join(dir, 'jsonl') },
    search: { ...d.search, mode },
  };
}

describe('rebuildFromJsonl — vec0 unloaded resilience (kizami v0.2.0 rebuild regression)', () => {
  it('does not throw "no such module: vec0" when chunks_vec exists but sqlite-vec is not pre-loaded', async () => {
    const dir = makeTmpDir();
    const config = makeTestConfig(dir, 'core');
    fs.mkdirSync(config.storage.jsonlDir, { recursive: true });

    // 既存DBに chunks_vec (vec0 仮想テーブル) を残した状態を再現する。
    // sqlite-vec を load して仮想テーブルを作成 → 接続を閉じる。
    // 次に open し直したときは vec0 module が未ロード状態になる。
    const db = new Database(config.database.path);
    initializeSchema(db);
    try {
      const { createRequire } = await import('node:module');
      const esmRequire = createRequire(import.meta.url);
      const sqliteVec = esmRequire('sqlite-vec') as { load: (db: Database.Database) => void };
      sqliteVec.load(db);
      db.prepare(`CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[256])`).run();
      db.prepare(
        `CREATE TABLE IF NOT EXISTS chunks_vec_map (chunk_id INTEGER PRIMARY KEY, vec_rowid INTEGER NOT NULL)`
      ).run();
    } catch (err) {
      // sqlite-vec が利用できない環境ではこのテスト自体をスキップ
      console.warn(`sqlite-vec not available in this environment; skipping: ${String(err)}`);
      db.close();
      return;
    }
    db.close();

    // JSONL に少量のレコードを書いて rebuild を実行する。
    const writer = new JsonlWriter(config.storage.jsonlDir);
    writer.appendRecords(
      [makeRec(randomUUID(), 0), makeRec(randomUUID(), 1)],
      new Date(Date.UTC(2026, 4, 21))
    );

    // rebuild が "no such module: vec0" で落ちないことを確認
    await expect(rebuildFromJsonl(config)).resolves.toMatchObject({
      chunksInserted: 2,
    });
  });
});
