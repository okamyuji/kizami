import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { JsonlTransactionWriter } from '@/jsonl/writer';
import type { LockedJsonlWriter } from '@/jsonl/writer';
import { serializeV2Transaction } from '@/jsonl/transaction';
import { readCanonicalTransactions } from '@/jsonl/reader';
import type { JsonlV2Payload } from '@/jsonl/types';
import type { TurnCheckpointV2 } from '@/checkpoint/types';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-txw-'));
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

function makePayload(overrides: Partial<TurnCheckpointV2> = {}): JsonlV2Payload {
  return { v: 2, type: 'turn_checkpoint', txId: 'tx-1', ...makeCheckpoint(overrides) };
}

describe('JsonlTransactionWriter', () => {
  it('appends a transaction and reads it back', async () => {
    const dir = makeTmpDir();
    const writer = new JsonlTransactionWriter(dir);

    try {
      const targetPath = path.join(dir, 'test.jsonl');
      const payload = makePayload();
      const serialized = serializeV2Transaction([payload], {
        txId: 'tx-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath,
      });

      writer.withExclusiveTransaction((w) => {
        const { receipt } = w.appendPrepared(serialized);
        expect(receipt.status).toBe('inserted');
        expect(receipt.txId).toBe('tx-1');
        w.applyCommittedToIndex(
          w.appendPrepared(
            serializeV2Transaction([payload], {
              txId: 'tx-1',
              createdAt: '2026-06-21T00:00:00.000Z',
              targetPath,
            })
          ).transaction
        );
      });

      const txns: Awaited<
        ReturnType<
          typeof readCanonicalTransactions extends AsyncGenerator<infer T> ? () => T : never
        >
      >[] = [];
      for await (const result of readCanonicalTransactions(targetPath)) {
        if (result.kind === 'transaction') txns.push(result);
      }
      expect(txns).toHaveLength(1);
    } finally {
      writer.close();
    }
  });

  it('returns already_committed for duplicate txId + digest', () => {
    const dir = makeTmpDir();
    const writer = new JsonlTransactionWriter(dir);

    try {
      const targetPath = path.join(dir, 'test.jsonl');
      const payload = makePayload();
      const serialized = serializeV2Transaction([payload], {
        txId: 'tx-dup',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath,
      });

      writer.withExclusiveTransaction((w) => {
        w.appendPrepared(serialized);
      });

      writer.withExclusiveTransaction((w) => {
        const { receipt } = w.appendPrepared(serialized);
        expect(receipt.status).toBe('already_committed');
      });

      const content = fs.readFileSync(targetPath, 'utf-8');
      const commitLines = content.split('\n').filter((l) => l.includes('"tx_commit"'));
      expect(commitLines).toHaveLength(1);
    } finally {
      writer.close();
    }
  });

  it('repairs partial tail before appending', () => {
    const dir = makeTmpDir();
    const targetPath = path.join(dir, 'test.jsonl');

    fs.writeFileSync(targetPath, '{"v":1,"type":"chunk","id":"x"}\nbroken-no-newline');

    const writer = new JsonlTransactionWriter(dir);
    try {
      const payload = makePayload();
      const serialized = serializeV2Transaction([payload], {
        txId: 'tx-repair',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath,
      });

      writer.withExclusiveTransaction((w) => {
        const { receipt } = w.appendPrepared(serialized);
        expect(receipt.status).toBe('inserted');
      });

      const corruptFiles = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
      expect(corruptFiles).toHaveLength(1);

      const content = fs.readFileSync(targetPath, 'utf-8');
      expect(content).not.toContain('broken-no-newline');
      expect(content).toContain('"tx_commit"');
    } finally {
      writer.close();
    }
  });

  it('handles abandoned frame followed by valid retry', async () => {
    const dir = makeTmpDir();
    const targetPath = path.join(dir, 'test.jsonl');

    const payload = makePayload();
    const serialized = serializeV2Transaction([payload], {
      txId: 'tx-retry',
      createdAt: '2026-06-21T00:00:00.000Z',
      targetPath,
    });

    // ponytail: simulate crash — write begin + payload, no commit
    const incomplete = serialized.allLines.slice(0, 2).join('\n') + '\n';
    fs.writeFileSync(targetPath, incomplete);

    const writer = new JsonlTransactionWriter(dir);
    try {
      writer.withExclusiveTransaction((w) => {
        const { receipt } = w.appendPrepared(serialized);
        expect(receipt.status).toBe('inserted');
      });

      let txCount = 0;
      let diagnosticCount = 0;
      for await (const result of readCanonicalTransactions(targetPath)) {
        if (result.kind === 'transaction') txCount++;
        if (result.kind === 'diagnostic') diagnosticCount++;
      }
      expect(txCount).toBe(1);
      expect(diagnosticCount).toBe(1);
    } finally {
      writer.close();
    }
  });

  describe('sequence allocation', () => {
    it('getOrCreateTurnSequence returns same value for duplicate pendingKey', () => {
      const dir = makeTmpDir();
      const writer = new JsonlTransactionWriter(dir);

      try {
        writer.withExclusiveTransaction((w) => {
          const a = w.getOrCreateTurnSequence('claude', 'sess-1', 'pk-1');
          const b = w.getOrCreateTurnSequence('claude', 'sess-1', 'pk-1');
          expect(a).toBe(b);
        });
      } finally {
        writer.close();
      }
    });

    it('getOrCreateTurnSequence increments for different pendingKeys', () => {
      const dir = makeTmpDir();
      const writer = new JsonlTransactionWriter(dir);

      try {
        writer.withExclusiveTransaction((w) => {
          const a = w.getOrCreateTurnSequence('claude', 'sess-1', 'pk-1');
          const b = w.getOrCreateTurnSequence('claude', 'sess-1', 'pk-2');
          expect(b).toBe(a + 1);
        });
      } finally {
        writer.close();
      }
    });

    it('reserveObservationSequence increments atomically', () => {
      const dir = makeTmpDir();
      const writer = new JsonlTransactionWriter(dir);

      try {
        writer.withExclusiveTransaction((w) => {
          const a = w.reserveObservationSequence('codex', 'sess-1');
          const b = w.reserveObservationSequence('codex', 'sess-1');
          expect(b).toBe(a + 1);
        });
      } finally {
        writer.close();
      }
    });

    it('allocateTurnSequenceRange returns contiguous range', () => {
      const dir = makeTmpDir();
      const writer = new JsonlTransactionWriter(dir);

      try {
        writer.withExclusiveTransaction((w) => {
          w.getOrCreateTurnSequence('claude', 'sess-1', 'pk-1');
          const range = w.allocateTurnSequenceRange('claude', 'sess-1', 3);
          expect(range).toEqual([2, 3, 4]);
        });
      } finally {
        writer.close();
      }
    });
  });

  describe('turn head tracking', () => {
    it('stores and retrieves turn heads after applyCommittedToIndex', () => {
      const dir = makeTmpDir();
      const writer = new JsonlTransactionWriter(dir);

      try {
        const targetPath = path.join(dir, 'test.jsonl');
        const payload = makePayload({ turnKey: 'tk-head', revision: 1 });
        const serialized = serializeV2Transaction([payload], {
          txId: 'tx-head',
          createdAt: '2026-06-21T00:00:00.000Z',
          targetPath,
        });

        writer.withExclusiveTransaction((w) => {
          const { transaction } = w.appendPrepared(serialized);
          w.applyCommittedToIndex(transaction);

          const head = w.getTurnHead('sess-1', 'tk-head');
          expect(head).toBeDefined();
          expect(head!.revision).toBe(1);
          expect(head!.contentHash).toBe('hash-1');
        });
      } finally {
        writer.close();
      }
    });

    it('returns undefined for unknown turn head', () => {
      const dir = makeTmpDir();
      const writer = new JsonlTransactionWriter(dir);

      try {
        writer.withExclusiveTransaction((w) => {
          expect(w.getTurnHead('nope', 'nope')).toBeUndefined();
        });
      } finally {
        writer.close();
      }
    });
  });

  describe('session epochs', () => {
    it('allocates incrementing epochs', () => {
      const dir = makeTmpDir();
      const writer = new JsonlTransactionWriter(dir);

      try {
        writer.withExclusiveTransaction((w) => {
          expect(w.getSessionEpoch('sess-1')).toBe(0);
          expect(w.allocateSessionEpoch('sess-1')).toBe(1);
          expect(w.allocateSessionEpoch('sess-1')).toBe(2);
          expect(w.getSessionEpoch('sess-1')).toBe(2);
        });
      } finally {
        writer.close();
      }
    });
  });
});
