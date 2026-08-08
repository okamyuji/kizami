import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { commitCheckpointBatch } from '@/checkpoint/coordinator';
import type { CheckpointBatch } from '@/checkpoint/coordinator';
import type { TurnCheckpointCandidate } from '@/checkpoint/types';
import type { EngramConfig } from '@/config';
import { getDefaultConfig } from '@/config';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { getDatabase } from '@/db/connection';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-coord-'));
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
  fs.mkdirSync(jsonlDir, { recursive: true, mode: 0o700 });

  // Pre-create and initialize the database
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
    assistant: 'Hi there',
    messages: [],
    ...overrides,
  };
}

describe('commitCheckpointBatch', () => {
  it('commits a single turn checkpoint', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);

    const batch: CheckpointBatch = {
      runtime: 'claude',
      sessionId: 'sess-1',
      candidates: [makeCandidate()],
      finalization: { pendingPaths: [] },
    };

    const results = await commitCheckpointBatch(batch, config);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('inserted');
    expect(results[0].revision).toBe(1);

    // Verify in SQLite
    const db = getDatabase(config.database.path);
    const store = new Store(db);
    const state = store.getStoredTurnState('sess-1', 'tk-1');
    expect(state).toBeDefined();
    expect(state!.revision).toBe(1);
    db.close();
  });

  it('returns already_current for identical content', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);

    const batch: CheckpointBatch = {
      runtime: 'claude',
      sessionId: 'sess-1',
      candidates: [makeCandidate()],
      finalization: { pendingPaths: [] },
    };

    await commitCheckpointBatch(batch, config);
    const results = await commitCheckpointBatch(batch, config);
    expect(results[0].status).toBe('already_current');
  });

  it('increments revision for changed content', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);

    const batch1: CheckpointBatch = {
      runtime: 'claude',
      sessionId: 'sess-1',
      candidates: [makeCandidate({ assistant: 'First response' })],
      finalization: { pendingPaths: [] },
    };

    const batch2: CheckpointBatch = {
      runtime: 'claude',
      sessionId: 'sess-1',
      candidates: [
        makeCandidate({
          assistant: 'Updated response',
          observedThrough: { kind: 'source_offset', generation: 0, offset: 200 },
        }),
      ],
      finalization: { pendingPaths: [] },
    };

    await commitCheckpointBatch(batch1, config);
    const results = await commitCheckpointBatch(batch2, config);
    expect(results[0].status).toBe('inserted');
    expect(results[0].revision).toBe(2);
  });

  it('rejects stale older observation', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);

    const batch1: CheckpointBatch = {
      runtime: 'claude',
      sessionId: 'sess-1',
      candidates: [
        makeCandidate({
          observedThrough: { kind: 'source_offset', generation: 0, offset: 200 },
        }),
      ],
      finalization: { pendingPaths: [] },
    };

    const batch2: CheckpointBatch = {
      runtime: 'claude',
      sessionId: 'sess-1',
      candidates: [
        makeCandidate({
          assistant: 'Old content',
          observedThrough: { kind: 'source_offset', generation: 0, offset: 50 },
        }),
      ],
      finalization: { pendingPaths: [] },
    };

    await commitCheckpointBatch(batch1, config);
    const results = await commitCheckpointBatch(batch2, config);
    expect(results[0].status).toBe('stale');
  });

  it('commits a reset baseline', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);

    // Insert legacy data
    const db = getDatabase(config.database.path);
    const store = new Store(db);
    store.insertChunks([
      {
        sessionId: 'sess-1',
        projectPath: '/tmp',
        chunkIndex: 0,
        content: 'legacy',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 1,
      },
    ]);
    db.close();

    const batch: CheckpointBatch = {
      runtime: 'claude',
      sessionId: 'sess-1',
      candidates: [makeCandidate()],
      resetReason: 'legacy_mismatch',
      finalization: { pendingPaths: [] },
    };

    const results = await commitCheckpointBatch(batch, config);
    expect(results[0].status).toBe('inserted');

    const db2 = getDatabase(config.database.path);
    const store2 = new Store(db2);
    const count = store2.countChunksForSession('sess-1');
    expect(count).toBe(1); // Only baseline, no legacy
    db2.close();
  });

  it('keeps an unchanged turn in a newly allocated reset epoch', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    const candidate = makeCandidate();

    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [candidate],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const resetResults = await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [candidate],
        resetReason: 'legacy_mismatch',
        finalization: { pendingPaths: [] },
      },
      config
    );

    expect(resetResults).toMatchObject([{ status: 'inserted', turnKey: 'tk-1', revision: 1 }]);
    const db = getDatabase(config.database.path);
    const store = new Store(db);
    expect(store.getStoredTurnState('sess-1', 'tk-1')).toMatchObject({
      historyEpoch: 1,
      revision: 1,
    });
    expect(store.countChunksForSession('sess-1')).toBe(1);
    db.close();
  });

  it('removes pending files on success', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);

    const pendingFile = path.join(dir, 'pending-test.json');
    fs.writeFileSync(pendingFile, '{}');

    const batch: CheckpointBatch = {
      runtime: 'claude',
      sessionId: 'sess-1',
      candidates: [makeCandidate()],
      finalization: { pendingPaths: [pendingFile] },
    };

    await commitCheckpointBatch(batch, config);
    expect(fs.existsSync(pendingFile)).toBe(false);
  });

  it('rejects more than 4096 payloads before writing JSONL or a receipt', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    const candidates = Array.from({ length: 4097 }, (_, index) =>
      makeCandidate({
        turnKey: `turn-${index}`,
        sourceOrder: String(index + 1).padStart(20, '0'),
        observedThrough: { kind: 'source_offset', generation: 0, offset: index + 1 },
      })
    );

    await expect(
      commitCheckpointBatch(
        {
          runtime: 'claude',
          sessionId: 'sess-1',
          candidates,
          finalization: { pendingPaths: [] },
        },
        config
      )
    ).rejects.toThrow(/4096 payload records/);

    expect(fs.readdirSync(config.storage.jsonlDir).some((name) => name.endsWith('.jsonl'))).toBe(
      false
    );
    expect(fs.existsSync(path.join(dir, 'prepared', 'claude'))).toBe(false);
  });

  it('rejects a receipt larger than 64 MiB before writing JSONL', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    const oversizedPath = path.join(dir, `${'x'.repeat(64 * 1024 * 1024)}.json`);

    await expect(
      commitCheckpointBatch(
        {
          runtime: 'claude',
          sessionId: 'sess-1',
          candidates: [makeCandidate()],
          finalization: { pendingPaths: [oversizedPath] },
        },
        config
      )
    ).rejects.toThrow(/Prepared receipt exceeds/);

    expect(fs.readdirSync(config.storage.jsonlDir).some((name) => name.endsWith('.jsonl'))).toBe(
      false
    );
    expect(fs.existsSync(path.join(dir, 'prepared', 'claude'))).toBe(false);
  });
});
