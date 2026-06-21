import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { commitCheckpointBatch, recoverPreparedCheckpoints } from '@/checkpoint/coordinator';
import type { CheckpointBatch } from '@/checkpoint/coordinator';
import type { TurnCheckpointCandidate } from '@/checkpoint/types';
import type { EngramConfig } from '@/config';
import { getDefaultConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-recov-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeConfig(dir: string): EngramConfig {
  const defaults = getDefaultConfig();
  const jsonlDir = path.join(dir, 'jsonl');
  const dbPath = path.join(dir, 'memory.db');
  fs.mkdirSync(jsonlDir, { recursive: true });
  const db = getDatabase(dbPath);
  initializeSchema(db);
  db.close();
  return {
    ...defaults,
    database: { path: dbPath },
    storage: { ...defaults.storage, jsonlDir },
  };
}

function makeCandidate(overrides: Partial<TurnCheckpointCandidate> = {}): TurnCheckpointCandidate {
  return {
    runtime: 'claude',
    sessionId: 'sess-1',
    turnKey: 'tk-1',
    sourceOrder: '00000000000000000001',
    observedThrough: { kind: 'source_offset', generation: 0, offset: 100 },
    projectPath: '/tmp/proj',
    completedAt: '2026-06-21T00:00:00.000Z',
    prompt: 'Hello',
    assistant: 'Hi',
    messages: [],
    ...overrides,
  };
}

describe('recoverPreparedCheckpoints', () => {
  it('returns zeros when no prepared receipts exist', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    const result = await recoverPreparedCheckpoints(config);
    expect(result).toEqual({ finalized: 0, superseded: 0, failed: 0 });
  });

  it('recovers a committed-but-not-finalized receipt', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);

    const batch: CheckpointBatch = {
      runtime: 'claude',
      sessionId: 'sess-1',
      candidates: [makeCandidate()],
      finalization: { pendingPaths: [] },
    };

    await commitCheckpointBatch(batch, config);

    // Verify data is already in SQLite
    const db = getDatabase(config.database.path);
    const store = new Store(db);
    expect(store.getStoredTurnState('sess-1', 'tk-1')).toBeDefined();
    db.close();

    // Recovery should handle already-finalized cleanly
    const result = await recoverPreparedCheckpoints(config, 'claude');
    expect(result.failed).toBe(0);
  });
});
