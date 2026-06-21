import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '@/db/store';
import { initializeSchema } from '@/db/schema';
import type { TurnCheckpointV2 } from '@/checkpoint/types';

let db: Database.Database;
let store: Store;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  store = new Store(db);
});

afterEach(() => {
  db.close();
});

function makeCheckpoint(overrides: Partial<TurnCheckpointV2> = {}): TurnCheckpointV2 {
  return {
    sessionId: 'sess-1',
    runtime: 'claude',
    turnKey: 'tk-1',
    sourceOrder: '00000000000000000001',
    observedThrough: { kind: 'source_offset', generation: 0, offset: 100 },
    historyEpoch: 0,
    revision: 1,
    contentHash: 'hash-1',
    completedAt: '2026-06-21T00:00:00.000Z',
    projectPath: '/tmp/proj',
    parts: [
      {
        partIndex: 0,
        externalId: 'ext-0',
        content: 'Hello world',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 2,
      },
    ],
    ...overrides,
  };
}

describe('applyTurnCheckpoint', () => {
  it('inserts a new checkpoint', () => {
    const result = store.applyTurnCheckpoint(makeCheckpoint());
    expect(result.status).toBe('inserted');
    expect(result.revision).toBe(1);

    const state = store.getStoredTurnState('sess-1', 'tk-1');
    expect(state).toBeDefined();
    expect(state!.revision).toBe(1);
  });

  it('returns already_current for identical revision and hash', () => {
    store.applyTurnCheckpoint(makeCheckpoint());
    const result = store.applyTurnCheckpoint(makeCheckpoint());
    expect(result.status).toBe('already_current');
  });

  it('returns stale for older revision', () => {
    store.applyTurnCheckpoint(makeCheckpoint({ revision: 2, contentHash: 'hash-2' }));
    const result = store.applyTurnCheckpoint(
      makeCheckpoint({ revision: 1, contentHash: 'hash-1' })
    );
    expect(result.status).toBe('stale');
  });

  it('returns stale for older observation boundary', () => {
    store.applyTurnCheckpoint(
      makeCheckpoint({ observedThrough: { kind: 'source_offset', generation: 0, offset: 200 } })
    );
    const result = store.applyTurnCheckpoint(
      makeCheckpoint({
        revision: 2,
        contentHash: 'hash-2',
        observedThrough: { kind: 'source_offset', generation: 0, offset: 50 },
      })
    );
    expect(result.status).toBe('stale');
  });

  it('returns conflict for equal revision with different hash', () => {
    store.applyTurnCheckpoint(makeCheckpoint({ revision: 1, contentHash: 'hash-A' }));
    const result = store.applyTurnCheckpoint(
      makeCheckpoint({ revision: 1, contentHash: 'hash-B' })
    );
    expect(result.status).toBe('conflict');
  });

  it('higher revision replaces prior parts', () => {
    store.applyTurnCheckpoint(
      makeCheckpoint({
        revision: 1,
        contentHash: 'hash-1',
        parts: [
          {
            partIndex: 0,
            externalId: 'ext-0',
            content: 'Part A',
            role: 'human',
            metadata: { filePaths: [], toolNames: [], errorMessages: [] },
            tokenCount: 1,
          },
          {
            partIndex: 1,
            externalId: 'ext-1',
            content: 'Part B',
            role: 'assistant',
            metadata: { filePaths: [], toolNames: [], errorMessages: [] },
            tokenCount: 1,
          },
        ],
      })
    );

    const result = store.applyTurnCheckpoint(
      makeCheckpoint({
        revision: 2,
        contentHash: 'hash-2',
        parts: [
          {
            partIndex: 0,
            externalId: 'ext-0',
            content: 'Revised',
            role: 'human',
            metadata: { filePaths: [], toolNames: [], errorMessages: [] },
            tokenCount: 1,
          },
        ],
      })
    );

    expect(result.status).toBe('inserted');
    const count = store.countChunksForSession('sess-1');
    expect(count).toBe(1);
  });

  it('reindexes chunk indices contiguously', () => {
    store.applyTurnCheckpoint(
      makeCheckpoint({
        turnKey: 'tk-a',
        sourceOrder: '00000000000000000001',
      })
    );
    store.applyTurnCheckpoint(
      makeCheckpoint({
        turnKey: 'tk-b',
        sourceOrder: '00000000000000000002',
        contentHash: 'hash-b',
        parts: [
          {
            partIndex: 0,
            externalId: 'ext-b0',
            content: 'Second',
            role: 'assistant',
            metadata: { filePaths: [], toolNames: [], errorMessages: [] },
            tokenCount: 1,
          },
        ],
      })
    );

    const maxIdx = store.getMaxChunkIndex('sess-1');
    expect(maxIdx).toBe(1);
  });
});

describe('replaceSessionWithBaseline', () => {
  it('atomically replaces all rows', () => {
    // Insert a v1-style row first
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

    const cp = makeCheckpoint({ historyEpoch: 1 });
    store.replaceSessionWithBaseline('sess-1', [cp]);

    const count = store.countChunksForSession('sess-1');
    expect(count).toBe(1);

    const state = store.getStoredTurnState('sess-1', 'tk-1');
    expect(state).toBeDefined();
    expect(state!.historyEpoch).toBe(1);
  });
});

describe('recomputeSessionMetadata', () => {
  it('updates session with correct chunk count', () => {
    store.applyTurnCheckpoint(makeCheckpoint());
    const session = store.getSession('sess-1');
    expect(session).toBeDefined();
    expect(session!.chunkCount).toBe(1);
  });

  it('removes session when all chunks deleted', () => {
    store.applyTurnCheckpoint(makeCheckpoint());
    db.prepare('DELETE FROM chunks WHERE session_id = ?').run('sess-1');
    store.recomputeSessionMetadata('sess-1');
    expect(store.getSession('sess-1')).toBeUndefined();
  });
});
