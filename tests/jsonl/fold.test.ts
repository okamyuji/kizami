import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foldCanonicalHistory, rebuildCanonicalIndex } from '@/jsonl/fold';
import { serializeV2Transaction } from '@/jsonl/transaction';
import type { JsonlV2Payload, JsonlChunkRecord } from '@/jsonl/types';
import type { TurnCheckpointV2 } from '@/checkpoint/types';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-fold-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
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
        content: 'Hello',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 1,
      },
    ],
    ...overrides,
  };
}

function writeV1Records(filePath: string, records: JsonlChunkRecord[]): void {
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines);
}

function writeV2Transaction(
  filePath: string,
  payloads: JsonlV2Payload[],
  txId: string,
  append = false
): void {
  const serialized = serializeV2Transaction(payloads, {
    txId,
    createdAt: '2026-06-21T00:00:00.000Z',
    targetPath: filePath,
  });
  const data = serialized.allLines.join('\n') + '\n';
  if (append) {
    fs.appendFileSync(filePath, data);
  } else {
    fs.writeFileSync(filePath, data);
  }
}

describe('foldCanonicalHistory', () => {
  it('reads legacy v1 chunks', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    writeV1Records(file, [
      {
        v: 1,
        type: 'chunk',
        id: 'c1',
        sessionId: 'sess-1',
        projectPath: '/tmp',
        chunkIndex: 0,
        content: 'hello',
        role: 'human',
        metadata: null,
        tokenCount: 1,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);

    const history = await foldCanonicalHistory([file]);
    expect(history.legacyChunks).toHaveLength(1);
    expect(history.turns.size).toBe(0);
  });

  it('reads v2 turn checkpoints from committed transactions', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    const payload: JsonlV2Payload = {
      v: 2,
      type: 'turn_checkpoint',
      txId: 'tx-1',
      ...makeCheckpoint(),
    };
    writeV2Transaction(file, [payload], 'tx-1');

    const history = await foldCanonicalHistory([file]);
    expect(history.legacyChunks).toHaveLength(0);
    expect(history.turns.size).toBe(1);
  });

  it('ignores incomplete transactions', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    // Write only tx_begin + payload, no commit
    const begin = JSON.stringify({
      v: 2,
      type: 'tx_begin',
      txId: 'tx-bad',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const payload = JSON.stringify({
      v: 2,
      type: 'turn_checkpoint',
      txId: 'tx-bad',
      ...makeCheckpoint(),
    });
    fs.writeFileSync(file, begin + '\n' + payload + '\n');

    const history = await foldCanonicalHistory([file]);
    expect(history.turns.size).toBe(0);
    expect(history.errors).toHaveLength(0);
  });

  it('accepts an abandoned frame only when the committed retry has the same payload', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    const serialized = serializeV2Transaction(
      [{ v: 2, type: 'turn_checkpoint', txId: 'tx-retry', ...makeCheckpoint() }],
      { txId: 'tx-retry', createdAt: '2026-06-21T00:00:00.000Z', targetPath: file }
    );
    fs.writeFileSync(
      file,
      `${serialized.allLines.slice(0, -1).join('\n')}\n${serialized.allLines.join('\n')}\n`
    );

    const history = await foldCanonicalHistory([file]);

    expect(history.turns.size).toBe(1);
    expect(history.errors).toEqual([]);
  });

  it('rejects a committed frame that reuses an abandoned tx ID with different payload', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    const abandoned = serializeV2Transaction(
      [{ v: 2, type: 'turn_checkpoint', txId: 'tx-retry', ...makeCheckpoint() }],
      { txId: 'tx-retry', createdAt: '2026-06-21T00:00:00.000Z', targetPath: file }
    );
    const committed = serializeV2Transaction(
      [
        {
          v: 2,
          type: 'turn_checkpoint',
          txId: 'tx-retry',
          ...makeCheckpoint({ contentHash: 'different-payload' }),
        },
      ],
      { txId: 'tx-retry', createdAt: '2026-06-21T00:00:01.000Z', targetPath: file }
    );
    fs.writeFileSync(
      file,
      `${abandoned.allLines.slice(0, -1).join('\n')}\n${committed.allLines.join('\n')}\n`
    );

    const history = await foldCanonicalHistory([file]);

    expect(history.errors).toMatchObject([
      {
        code: 'invalid_transaction',
        txId: 'tx-retry',
        message: expect.stringContaining('abandoned'),
      },
    ]);
  });

  it('keeps an abandoned-frame error when no committed transaction has that tx ID', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    const abandoned = serializeV2Transaction(
      [{ v: 2, type: 'turn_checkpoint', txId: 'tx-abandoned', ...makeCheckpoint() }],
      { txId: 'tx-abandoned', createdAt: '2026-06-21T00:00:00.000Z', targetPath: file }
    );
    const committed = serializeV2Transaction(
      [
        {
          v: 2,
          type: 'turn_checkpoint',
          txId: 'tx-other',
          ...makeCheckpoint({ turnKey: 'other-turn' }),
        },
      ],
      { txId: 'tx-other', createdAt: '2026-06-21T00:00:01.000Z', targetPath: file }
    );
    fs.writeFileSync(
      file,
      `${abandoned.allLines.slice(0, -1).join('\n')}\n${committed.allLines.join('\n')}\n`
    );

    const history = await foldCanonicalHistory([file]);

    expect(history.errors).toMatchObject([
      {
        code: 'invalid_transaction',
        txId: 'tx-abandoned',
        message: expect.stringContaining('abandoned'),
      },
    ]);
  });

  it('rejects two committed frames that reuse one tx ID for different payloads', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    writeV2Transaction(
      file,
      [{ v: 2, type: 'turn_checkpoint', txId: 'tx-duplicate', ...makeCheckpoint() }],
      'tx-duplicate'
    );
    writeV2Transaction(
      file,
      [
        {
          v: 2,
          type: 'turn_checkpoint',
          txId: 'tx-duplicate',
          ...makeCheckpoint({ turnKey: 'different-turn', contentHash: 'different-content' }),
        },
      ],
      'tx-duplicate',
      true
    );

    const history = await foldCanonicalHistory([file]);

    expect([...history.turns.values()].map((turn) => turn.turnKey)).toEqual(['tk-1']);
    expect(history.errors).toMatchObject([
      {
        code: 'invalid_transaction',
        txId: 'tx-duplicate',
        message: expect.stringContaining('different payload digest'),
      },
    ]);
  });

  it('deduplicates same revision/same hash', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    const checkpoint = makeCheckpoint({ revision: 1, contentHash: 'same-hash' });
    const payload: JsonlV2Payload = { v: 2, type: 'turn_checkpoint', txId: 'tx-1', ...checkpoint };
    writeV2Transaction(file, [payload], 'tx-1');
    writeV2Transaction(file, [payload], 'tx-1-dup', true);

    const history = await foldCanonicalHistory([file]);
    expect(history.turns.size).toBe(1);
    expect(history.errors).toHaveLength(0);
  });

  it('reports equal revision with different content hash as conflict', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    const cp1 = makeCheckpoint({ revision: 1, contentHash: 'hash-A' });
    const cp2 = makeCheckpoint({ revision: 1, contentHash: 'hash-B' });
    writeV2Transaction(file, [{ v: 2, type: 'turn_checkpoint', txId: 'tx-1', ...cp1 }], 'tx-1');
    writeV2Transaction(
      file,
      [{ v: 2, type: 'turn_checkpoint', txId: 'tx-2', ...cp2 }],
      'tx-2',
      true
    );

    const history = await foldCanonicalHistory([file]);
    expect(history.errors.some((e) => e.code === 'revision_conflict')).toBe(true);
  });

  it('selects higher revision', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    const cp1 = makeCheckpoint({ revision: 1, contentHash: 'hash-1' });
    const cp2 = makeCheckpoint({ revision: 2, contentHash: 'hash-2' });
    writeV2Transaction(file, [{ v: 2, type: 'turn_checkpoint', txId: 'tx-1', ...cp1 }], 'tx-1');
    writeV2Transaction(
      file,
      [{ v: 2, type: 'turn_checkpoint', txId: 'tx-2', ...cp2 }],
      'tx-2',
      true
    );

    const history = await foldCanonicalHistory([file]);
    const turn = [...history.turns.values()][0];
    expect(turn.revision).toBe(2);
    expect(turn.contentHash).toBe('hash-2');
  });

  it('selects the maximum epoch before revision and ignores conflicts only in an old epoch', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    const oldA = makeCheckpoint({ historyEpoch: 0, revision: 9, contentHash: 'old-a' });
    const oldB = makeCheckpoint({ historyEpoch: 0, revision: 9, contentHash: 'old-b' });
    const reset: JsonlV2Payload = {
      v: 2,
      type: 'session_reset',
      txId: 'tx-new',
      sessionId: 'sess-1',
      historyEpoch: 1,
      reason: 'legacy_mismatch',
    };
    const current = makeCheckpoint({ historyEpoch: 1, revision: 1, contentHash: 'current' });
    writeV2Transaction(file, [{ v: 2, type: 'turn_checkpoint', txId: 'tx-a', ...oldA }], 'tx-a');
    writeV2Transaction(
      file,
      [{ v: 2, type: 'turn_checkpoint', txId: 'tx-b', ...oldB }],
      'tx-b',
      true
    );
    writeV2Transaction(
      file,
      [reset, { v: 2, type: 'turn_checkpoint', txId: 'tx-new', ...current }],
      'tx-new',
      true
    );

    const history = await foldCanonicalHistory([file]);
    expect([...history.turns.values()][0]).toMatchObject({ historyEpoch: 1, revision: 1 });
    expect(history.errors).toEqual([]);
  });

  it('suppresses v1 legacy chunks when reset exists', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');

    // v1 legacy record
    const v1Line = JSON.stringify({
      v: 1,
      type: 'chunk',
      id: 'legacy-1',
      sessionId: 'sess-1',
      projectPath: '/tmp',
      chunkIndex: 0,
      content: 'old',
      role: 'human',
      metadata: null,
      tokenCount: 1,
      createdAt: '2026-01-01T00:00:00Z',
    });

    // v2 reset + checkpoint
    const resetPayload: JsonlV2Payload = {
      v: 2,
      type: 'session_reset',
      txId: 'tx-reset',
      sessionId: 'sess-1',
      historyEpoch: 1,
      reason: 'legacy_mismatch',
    };
    const cp = makeCheckpoint({ historyEpoch: 1 });
    const cpPayload: JsonlV2Payload = { v: 2, type: 'turn_checkpoint', txId: 'tx-reset', ...cp };

    const serialized = serializeV2Transaction([resetPayload, cpPayload], {
      txId: 'tx-reset',
      createdAt: '2026-06-21T00:00:00.000Z',
      targetPath: file,
    });

    fs.writeFileSync(file, v1Line + '\n' + serialized.allLines.join('\n') + '\n');

    const history = await foldCanonicalHistory([file]);
    expect(history.legacyChunks).toHaveLength(0);
    expect(history.resetSessions.has('sess-1')).toBe(true);
    expect(history.turns.size).toBe(1);
  });

  it('uncommitted reset is invisible', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');

    const v1Line = JSON.stringify({
      v: 1,
      type: 'chunk',
      id: 'legacy-1',
      sessionId: 'sess-1',
      projectPath: '/tmp',
      chunkIndex: 0,
      content: 'old',
      role: 'human',
      metadata: null,
      tokenCount: 1,
      createdAt: '2026-01-01T00:00:00Z',
    });

    // Incomplete reset transaction (no commit)
    const begin = JSON.stringify({
      v: 2,
      type: 'tx_begin',
      txId: 'tx-bad-reset',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const resetLine = JSON.stringify({
      v: 2,
      type: 'session_reset',
      txId: 'tx-bad-reset',
      sessionId: 'sess-1',
      historyEpoch: 1,
      reason: 'legacy_mismatch',
    });

    fs.writeFileSync(file, v1Line + '\n' + begin + '\n' + resetLine + '\n');

    const history = await foldCanonicalHistory([file]);
    expect(history.legacyChunks).toHaveLength(1);
    expect(history.resetSessions.size).toBe(0);
  });

  it('chooses highest historyEpoch and filters lower checkpoints', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');

    const reset1: JsonlV2Payload = {
      v: 2,
      type: 'session_reset',
      txId: 'tx-r1',
      sessionId: 'sess-1',
      historyEpoch: 1,
      reason: 'legacy_mismatch',
    };
    const cpEpoch1 = makeCheckpoint({ historyEpoch: 1, turnKey: 'tk-old', contentHash: 'old' });
    writeV2Transaction(
      file,
      [reset1, { v: 2, type: 'turn_checkpoint', txId: 'tx-r1', ...cpEpoch1 }],
      'tx-r1'
    );

    const reset2: JsonlV2Payload = {
      v: 2,
      type: 'session_reset',
      txId: 'tx-r2',
      sessionId: 'sess-1',
      historyEpoch: 2,
      reason: 'legacy_mismatch',
    };
    const cpEpoch2 = makeCheckpoint({ historyEpoch: 2, turnKey: 'tk-new', contentHash: 'new' });
    writeV2Transaction(
      file,
      [reset2, { v: 2, type: 'turn_checkpoint', txId: 'tx-r2', ...cpEpoch2 }],
      'tx-r2',
      true
    );

    const history = await foldCanonicalHistory([file]);
    // Epoch 1 checkpoint should be filtered out
    const turnKeys = [...history.turns.values()].map((t) => t.turnKey);
    expect(turnKeys).toContain('tk-new');
    expect(turnKeys).not.toContain('tk-old');
  });
});

describe('rebuildCanonicalIndex', () => {
  it('throws on revision conflict', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    const cp1 = makeCheckpoint({ revision: 1, contentHash: 'hash-A' });
    const cp2 = makeCheckpoint({ revision: 1, contentHash: 'hash-B' });
    writeV2Transaction(file, [{ v: 2, type: 'turn_checkpoint', txId: 'tx-1', ...cp1 }], 'tx-1');
    writeV2Transaction(
      file,
      [{ v: 2, type: 'turn_checkpoint', txId: 'tx-2', ...cp2 }],
      'tx-2',
      true
    );

    await expect(
      rebuildCanonicalIndex(dir, [file], { pendingRoot: dir, preparedRoot: dir })
    ).rejects.toThrow('revision conflicts');
  });

  it('succeeds with clean history', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    const cp = makeCheckpoint();
    writeV2Transaction(file, [{ v: 2, type: 'turn_checkpoint', txId: 'tx-1', ...cp }], 'tx-1');

    const result = await rebuildCanonicalIndex(dir, [file], {
      pendingRoot: dir,
      preparedRoot: dir,
    });
    expect(result.filesProcessed).toBe(1);
    expect(result.transactionsIndexed).toBe(1);
  });
});
