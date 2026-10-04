import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { JsonlWriter, JsonlTransactionWriter } from '@/jsonl/writer';
import { listJsonlFiles, getJsonlFilePath } from '@/jsonl/path';
import { foldCanonicalHistory } from '@/jsonl/fold';
import { serializeV2Transaction, isJsonlV2Payload } from '@/jsonl/transaction';
import { selfHealFromJsonl } from '@/jsonl/self_heal';
import { readTailRecords, readTailDeletions } from '@/jsonl/reader';
import { createHash } from 'node:crypto';
import { appendSessionDeletion, appendChunkDeletion } from '@/jsonl/deletion';
import type { JsonlChunkRecord } from '@/jsonl/types';
import type { TurnCheckpointV2 } from '@/checkpoint/types';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-deletion-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function record(id: string, sessionId: string, idx = 0): JsonlChunkRecord {
  return {
    v: 1,
    type: 'chunk',
    id,
    sessionId,
    projectPath: '/tmp/proj',
    chunkIndex: idx,
    content: `content-${id}`,
    role: 'human',
    metadata: JSON.stringify({ filePaths: [], toolNames: [], errorMessages: [] }),
    tokenCount: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

function part(externalId: string, partIndex: number): TurnCheckpointV2['parts'][number] {
  return {
    partIndex,
    externalId,
    content: `part-${externalId}`,
    role: 'human',
    metadata: { filePaths: [], toolNames: [], errorMessages: [] },
    tokenCount: 1,
  };
}

function writeTurn(dir: string, sessionId: string, turnKey: string, externalIds: string[]): void {
  const target = getJsonlFilePath(dir, new Date());
  const checkpoint: TurnCheckpointV2 = {
    sessionId,
    runtime: 'claude',
    turnKey,
    sourceOrder: '00000000000000000001',
    observedThrough: { kind: 'source_offset', generation: 0, offset: 1 },
    historyEpoch: 0,
    revision: 1,
    contentHash: `hash-${turnKey}`,
    completedAt: '2026-10-01T00:00:00.000Z',
    projectPath: '/tmp/proj',
    parts: externalIds.map(part),
  };
  const tx = serializeV2Transaction([{ v: 2, type: 'turn_checkpoint', txId: '', ...checkpoint }], {
    txId: `tx-${turnKey}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    targetPath: target,
  });
  fs.appendFileSync(target, tx.allLines.join('\n') + '\n');
}

async function fold(dir: string) {
  return foldCanonicalHistory(listJsonlFiles(dir));
}

describe('isJsonlV2Payload for deletions', () => {
  it('accepts chunk_delete and a session_reset with reason deleted', () => {
    expect(
      isJsonlV2Payload({ v: 2, type: 'chunk_delete', txId: 't', sessionId: 's', externalId: 'e' })
    ).toBe(true);
    expect(
      isJsonlV2Payload({
        v: 2,
        type: 'session_reset',
        txId: 't',
        sessionId: 's',
        historyEpoch: 1,
        reason: 'deleted',
      })
    ).toBe(true);
  });

  it.each([
    { v: 2, type: 'chunk_delete', txId: 't', sessionId: 's' },
    { v: 2, type: 'chunk_delete', txId: 't', externalId: 'e' },
    { v: 2, type: 'chunk_delete', sessionId: 's', externalId: 'e' },
    { v: 2, type: 'session_reset', txId: 't', sessionId: 's', historyEpoch: 1, reason: 'other' },
  ])('rejects a malformed deletion payload %o', (payload) => {
    expect(isJsonlV2Payload(payload)).toBe(false);
  });
});

describe('appendSessionDeletion', () => {
  it('drops every legacy record and turn of the session on fold, and keeps the others', async () => {
    const dir = makeTmpDir();
    new JsonlWriter(dir).appendRecords([record('a1', 's1'), record('b1', 's2')]);
    writeTurn(dir, 's1', 'tk-1', ['p1']);

    appendSessionDeletion(dir, 's1');

    const history = await fold(dir);
    expect(history.errors).toEqual([]);
    expect(history.legacyChunks.map((c) => c.id)).toEqual(['b1']);
    expect([...history.turns.values()]).toEqual([]);
  });

  it('allocates a new epoch each time and still folds cleanly', async () => {
    const dir = makeTmpDir();
    new JsonlWriter(dir).appendRecords([record('a1', 's1')]);
    appendSessionDeletion(dir, 's1');
    appendSessionDeletion(dir, 's1');
    const lines = fs
      .readFileSync(getJsonlFilePath(dir, new Date()), 'utf-8')
      .split('\n')
      .filter((l) => l.includes('"session_reset"'))
      .map((l) => JSON.parse(l) as { historyEpoch: number; reason: string });
    expect(lines.map((l) => [l.historyEpoch, l.reason])).toEqual([
      [1, 'deleted'],
      [2, 'deleted'],
    ]);
    expect((await fold(dir)).errors).toEqual([]);
  });
});

describe('appendChunkDeletion', () => {
  it('drops only the deleted legacy record on fold', async () => {
    const dir = makeTmpDir();
    new JsonlWriter(dir).appendRecords([record('a1', 's1', 0), record('a2', 's1', 1)]);

    appendChunkDeletion(dir, 's1', 'a1');

    const history = await fold(dir);
    expect(history.errors).toEqual([]);
    expect(history.legacyChunks.map((c) => c.id)).toEqual(['a2']);
  });

  it('drops only the deleted part of a v2 turn, and the turn when no part is left', async () => {
    const dir = makeTmpDir();
    writeTurn(dir, 's1', 'tk-1', ['p1', 'p2']);
    writeTurn(dir, 's1', 'tk-2', ['p3']);

    appendChunkDeletion(dir, 's1', 'p1');
    appendChunkDeletion(dir, 's1', 'p3');

    const history = await fold(dir);
    expect(history.errors).toEqual([]);
    const turns = [...history.turns.values()];
    expect(turns.map((t) => t.turnKey)).toEqual(['tk-1']);
    expect(turns[0].parts.map((p) => p.externalId)).toEqual(['p2']);
  });

  it('is safe to record the same deletion twice', async () => {
    const dir = makeTmpDir();
    new JsonlWriter(dir).appendRecords([record('a1', 's1'), record('a2', 's1', 1)]);
    appendChunkDeletion(dir, 's1', 'a1');
    appendChunkDeletion(dir, 's1', 'a1');
    const history = await fold(dir);
    expect(history.errors).toEqual([]);
    expect(history.legacyChunks.map((c) => c.id)).toEqual(['a2']);
  });
});

describe('selfHealFromJsonl with deletions', () => {
  function storeFor(dir: string): Store {
    const db = new Database(path.join(dir, 'test.db'));
    initializeSchema(db);
    return new Store(db);
  }

  it('does not re-insert a deleted chunk or a chunk of a deleted session', () => {
    const dir = makeTmpDir();
    new JsonlWriter(dir).appendRecords([
      record('keep', 's1', 0),
      record('gone', 's1', 1),
      record('other', 's2', 0),
    ]);
    appendChunkDeletion(dir, 's1', 'gone');
    appendSessionDeletion(dir, 's2');
    const store = storeFor(dir);

    const result = selfHealFromJsonl(store, dir, 100);

    expect(result.reinserted).toBe(1);
    expect(store.findMissingExternalIds(['keep', 'gone', 'other'])).toEqual(['gone', 'other']);
  });
});

describe('deletion transaction ids', () => {
  const sha = (...f: string[]) => createHash('sha256').update(f.join('\0')).digest('hex');
  const txIds = (dir: string, type: string) =>
    fs
      .readFileSync(getJsonlFilePath(dir, new Date()), 'utf-8')
      .split('\n')
      .filter((l) => l.includes(`"type":"${type}"`))
      .map((l) => (JSON.parse(l) as { txId: string }).txId);

  it('derives the chunk deletion txId from the kind, session and external id', () => {
    const dir = makeTmpDir();
    appendChunkDeletion(dir, 's1', 'a1');
    expect(txIds(dir, 'chunk_delete')).toEqual([sha('chunk_delete', 's1', 'a1')]);
  });

  it('derives the session deletion txId from the kind, session and epoch', () => {
    const dir = makeTmpDir();
    appendSessionDeletion(dir, 's1');
    expect(txIds(dir, 'session_reset')).toEqual([sha('session_delete', 's1', '1')]);
  });
});

describe('tail readers', () => {
  it('readTailRecords returns only v1 chunk records when v2 transactions are mixed in', () => {
    const dir = makeTmpDir();
    new JsonlWriter(dir).appendRecords([record('a1', 's1')]);
    writeTurn(dir, 's1', 'tk-1', ['p1']);
    new JsonlWriter(dir).appendRecords([record('a2', 's1', 1)]);
    expect(readTailRecords(getJsonlFilePath(dir, new Date()), 100).map((r) => r.id)).toEqual([
      'a1',
      'a2',
    ]);
  });

  it('readTailDeletions ignores malformed lines and sessions that only have turns', () => {
    const dir = makeTmpDir();
    const file = getJsonlFilePath(dir, new Date());
    writeTurn(dir, 's3', 'tk-1', ['p1']);
    fs.appendFileSync(file, '{not json\n');
    appendChunkDeletion(dir, 's1', 'a1');
    appendSessionDeletion(dir, 's2');
    const d = readTailDeletions(file, 100);
    expect([...d.chunkIds]).toEqual(['a1']);
    expect([...d.sessions]).toEqual(['s2']);
  });
});

describe('deletion writer lifecycle', () => {
  it('closes the transaction writer after writing', () => {
    const close = vi.spyOn(JsonlTransactionWriter.prototype, 'close');
    try {
      appendChunkDeletion(makeTmpDir(), 's1', 'a1');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
});
