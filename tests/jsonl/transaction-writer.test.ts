import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { JsonlTransactionWriter } from '@/jsonl/writer';
import {
  computePayloadDigest,
  MAX_JSONL_RECORD_BYTES,
  serializeV2Transaction,
} from '@/jsonl/transaction';
import { readCanonicalTransactions } from '@/jsonl/reader';
import type { JsonlV2Payload, JsonlV2Record } from '@/jsonl/types';
import type { SerializedJsonlTransaction } from '@/jsonl/types';
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

  it('rejects a cached txId reused with a different payload before appending', () => {
    const dir = makeTmpDir();
    const writer = new JsonlTransactionWriter(dir);

    try {
      const targetPath = path.join(dir, 'test.jsonl');
      const first = serializeV2Transaction([makePayload()], {
        txId: 'tx-reused',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath,
      });
      writer.withExclusiveTransaction((lockedWriter) => {
        const { transaction } = lockedWriter.appendPrepared(first);
        lockedWriter.applyCommittedToIndex(transaction);
      });

      const different = serializeV2Transaction(
        [makePayload({ contentHash: 'different-payload' })],
        {
          txId: 'tx-reused',
          createdAt: '2026-06-21T00:00:01.000Z',
          targetPath,
        }
      );
      expect(() =>
        writer.withExclusiveTransaction((lockedWriter) => {
          lockedWriter.appendPrepared(different);
        })
      ).toThrow(/different payload/);

      const commitLines = fs
        .readFileSync(targetPath, 'utf-8')
        .split('\n')
        .filter((line) => line.includes('"tx_commit"'));
      expect(commitLines).toHaveLength(1);
    } finally {
      writer.close();
    }
  });

  it('does not treat an orphan commit marker as a committed transaction', () => {
    const dir = makeTmpDir();
    const targetPath = path.join(dir, 'test.jsonl');
    const serialized = serializeV2Transaction([makePayload()], {
      txId: 'tx-orphan',
      createdAt: '2026-06-21T00:00:00.000Z',
      targetPath,
    });
    fs.writeFileSync(targetPath, `${serialized.allLines.at(-1)}\n`);
    const writer = new JsonlTransactionWriter(dir);

    try {
      writer.withExclusiveTransaction((lockedWriter) => {
        expect(lockedWriter.appendPrepared(serialized).receipt.status).toBe('inserted');
      });
      expect(fs.readFileSync(targetPath, 'utf-8').match(/"tx_commit"/g)).toHaveLength(2);
    } finally {
      writer.close();
    }
  });

  it('invalidates a positive cache entry after the JSONL file is truncated', () => {
    const dir = makeTmpDir();
    const targetPath = path.join(dir, 'test.jsonl');
    const serialized = serializeV2Transaction([makePayload()], {
      txId: 'tx-truncated',
      createdAt: '2026-06-21T00:00:00.000Z',
      targetPath,
    });
    const writer = new JsonlTransactionWriter(dir);

    try {
      writer.withExclusiveTransaction((lockedWriter) => {
        const { transaction } = lockedWriter.appendPrepared(serialized);
        lockedWriter.applyCommittedToIndex(transaction);
      });
      fs.truncateSync(targetPath, 0);

      writer.withExclusiveTransaction((lockedWriter) => {
        expect(lockedWriter.appendPrepared(serialized).receipt.status).toBe('inserted');
      });
      expect(fs.readFileSync(targetPath, 'utf-8').match(/"tx_commit"/g)).toHaveLength(1);
    } finally {
      writer.close();
    }
  });

  it('detects a conflicting committed frame appended after the cache snapshot', () => {
    const dir = makeTmpDir();
    const targetPath = path.join(dir, 'test.jsonl');
    const first = serializeV2Transaction([makePayload()], {
      txId: 'tx-conflict',
      createdAt: '2026-06-21T00:00:00.000Z',
      targetPath,
    });
    const different = serializeV2Transaction([makePayload({ contentHash: 'different-payload' })], {
      txId: 'tx-conflict',
      createdAt: '2026-06-21T00:00:01.000Z',
      targetPath,
    });
    const writer = new JsonlTransactionWriter(dir);

    try {
      writer.withExclusiveTransaction((lockedWriter) => {
        const { transaction } = lockedWriter.appendPrepared(first);
        lockedWriter.applyCommittedToIndex(transaction);
      });
      fs.appendFileSync(targetPath, `${different.allLines.join('\n')}\n`);

      expect(() =>
        writer.withExclusiveTransaction((lockedWriter) => {
          lockedWriter.findCommitted(targetPath, first.txId, first.payloadDigest);
        })
      ).toThrow(/different payload/);
    } finally {
      writer.close();
    }
  });

  it('fails closed without appending when an existing committed payload exceeds the scan limit', () => {
    const dir = makeTmpDir();
    const targetPath = path.join(dir, 'test.jsonl');
    const payload: JsonlV2Payload = {
      ...makePayload(),
      txId: 'tx-oversized-existing',
      parts: [
        {
          partIndex: 0,
          externalId: 'oversized',
          content: 'x'.repeat(MAX_JSONL_RECORD_BYTES),
          role: 'assistant',
          metadata: { filePaths: [], toolNames: [], errorMessages: [] },
          tokenCount: MAX_JSONL_RECORD_BYTES / 4,
        },
      ],
    };
    const payloadLine = JSON.stringify(payload);
    const payloadDigest = computePayloadDigest([payloadLine]);
    const beginRecord: JsonlV2Record = {
      v: 2,
      type: 'tx_begin',
      txId: payload.txId,
      createdAt: '2026-06-21T00:00:00.000Z',
    };
    const commitRecord: JsonlV2Record = {
      v: 2,
      type: 'tx_commit',
      txId: payload.txId,
      recordCount: 1,
      payloadDigest,
      createdAt: '2026-06-21T00:00:00.000Z',
    };
    const begin = JSON.stringify(beginRecord);
    const commit = JSON.stringify(commitRecord);
    const serialized: SerializedJsonlTransaction = {
      txId: payload.txId,
      createdAt: '2026-06-21T00:00:00.000Z',
      targetPath,
      payloadLines: [payloadLine],
      payloadDigest,
      allLines: [begin, payloadLine, commit],
      records: [beginRecord, payload, commitRecord],
    };
    fs.writeFileSync(targetPath, `${serialized.allLines.join('\n')}\n`);
    const sizeBefore = fs.statSync(targetPath).size;
    const writer = new JsonlTransactionWriter(dir);

    try {
      expect(() =>
        writer.withExclusiveTransaction((lockedWriter) => {
          lockedWriter.appendPrepared(serialized);
        })
      ).toThrow(/safe scan limit/);
      expect(fs.statSync(targetPath).size).toBe(sizeBefore);
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

  it.skipIf(process.platform === 'win32')(
    'rejects a transaction target symlink before writing',
    () => {
      const dir = makeTmpDir();
      const targetPath = path.join(dir, 'test.jsonl');
      const linkedTarget = path.join(dir, 'outside.jsonl');
      fs.writeFileSync(linkedTarget, 'unchanged\n');
      fs.symlinkSync(linkedTarget, targetPath);
      const writer = new JsonlTransactionWriter(dir);

      try {
        const serialized = serializeV2Transaction([makePayload()], {
          txId: 'tx-symlink',
          createdAt: '2026-06-21T00:00:00.000Z',
          targetPath,
        });
        expect(() =>
          writer.withExclusiveTransaction((lockedWriter) => {
            lockedWriter.appendPrepared(serialized);
          })
        ).toThrow(/symlink/);
        expect(fs.readFileSync(linkedTarget, 'utf-8')).toBe('unchanged\n');
      } finally {
        writer.close();
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a writer-lock database symlink before opening',
    () => {
      const dir = makeTmpDir();
      const linkedTarget = path.join(dir, 'outside.sqlite');
      fs.writeFileSync(linkedTarget, 'unchanged');
      fs.symlinkSync(linkedTarget, path.join(dir, '.writer-lock.sqlite'));

      expect(() => new JsonlTransactionWriter(dir)).toThrow(/symlink/);
      expect(fs.readFileSync(linkedTarget, 'utf-8')).toBe('unchanged');
    }
  );

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

    it('keeps turn heads monotonic across old, conflicting, and newer payloads', () => {
      const dir = makeTmpDir();
      const writer = new JsonlTransactionWriter(dir);

      try {
        writer.withExclusiveTransaction((w) => {
          const apply = (checkpoint: TurnCheckpointV2, txId: string): void => {
            w.applyCommittedToIndex({
              txId,
              createdAt: '2026-06-21T00:00:00.000Z',
              filePath: path.join(dir, 'missing.jsonl'),
              beginOffset: 0,
              endOffset: 0,
              payloadDigest: `digest-${txId}`,
              payloads: [{ v: 2, type: 'turn_checkpoint', txId, ...checkpoint }],
            });
          };

          apply(
            makeCheckpoint({
              turnKey: 'tk-monotonic',
              revision: 2,
              contentHash: 'revision-2',
              observedThrough: { kind: 'source_offset', generation: 0, offset: 200 },
            }),
            'tx-revision-2'
          );
          apply(
            makeCheckpoint({
              turnKey: 'tk-monotonic',
              revision: 1,
              contentHash: 'revision-1',
              observedThrough: { kind: 'source_offset', generation: 0, offset: 100 },
            }),
            'tx-revision-1'
          );
          expect(w.getTurnHead('sess-1', 'tk-monotonic')).toMatchObject({
            revision: 2,
            contentHash: 'revision-2',
          });

          apply(
            makeCheckpoint({
              turnKey: 'tk-monotonic',
              revision: 2,
              contentHash: 'revision-2',
              sourceOrder: '99999999999999999999',
              observedThrough: { kind: 'source_offset', generation: 0, offset: 999 },
            }),
            'tx-identical-revision-content'
          );
          expect(w.getTurnHead('sess-1', 'tk-monotonic')).toMatchObject({
            sourceOrder: '00000000000000000001',
            observedThrough: { kind: 'source_offset', generation: 0, offset: 200 },
          });

          expect(() =>
            apply(
              makeCheckpoint({
                turnKey: 'tk-monotonic',
                revision: 2,
                contentHash: 'conflict',
                observedThrough: { kind: 'source_offset', generation: 0, offset: 200 },
              }),
              'tx-conflict'
            )
          ).toThrow(/conflicting content/);
          expect(() =>
            apply(
              makeCheckpoint({
                turnKey: 'tk-monotonic',
                revision: 3,
                contentHash: 'older-boundary',
                observedThrough: { kind: 'source_offset', generation: 0, offset: 100 },
              }),
              'tx-older-boundary'
            )
          ).toThrow(/non-monotonic observation boundary/);

          apply(
            makeCheckpoint({
              turnKey: 'tk-monotonic',
              revision: 3,
              contentHash: 'revision-3',
              observedThrough: { kind: 'source_offset', generation: 0, offset: 200 },
            }),
            'tx-revision-3'
          );
          apply(
            makeCheckpoint({
              turnKey: 'tk-monotonic',
              historyEpoch: 1,
              revision: 1,
              contentHash: 'new-epoch',
              observedThrough: { kind: 'source_offset', generation: 1, offset: 1 },
            }),
            'tx-new-epoch'
          );
          expect(w.getTurnHead('sess-1', 'tk-monotonic')).toMatchObject({
            historyEpoch: 1,
            revision: 1,
            contentHash: 'new-epoch',
          });

          apply(
            makeCheckpoint({
              turnKey: 'tk-monotonic',
              historyEpoch: 0,
              revision: 99,
              contentHash: 'old-epoch',
              observedThrough: { kind: 'source_offset', generation: 9, offset: 999 },
            }),
            'tx-old-epoch'
          );
          expect(w.getTurnHead('sess-1', 'tk-monotonic')).toMatchObject({
            historyEpoch: 1,
            revision: 1,
            contentHash: 'new-epoch',
          });
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

    it('restores reset epochs from committed payloads without decreasing the current epoch', () => {
      const dir = makeTmpDir();
      const writer = new JsonlTransactionWriter(dir);

      try {
        const targetPath = path.join(dir, 'test.jsonl');
        writer.withExclusiveTransaction((w) => {
          const newer = serializeV2Transaction(
            [
              {
                v: 2,
                type: 'session_reset',
                txId: 'tx-reset-2',
                sessionId: 'sess-1',
                historyEpoch: 2,
                reason: 'legacy_mismatch',
              },
            ],
            {
              txId: 'tx-reset-2',
              createdAt: '2026-06-21T00:00:00.000Z',
              targetPath,
            }
          );
          w.applyCommittedToIndex(w.appendPrepared(newer).transaction);
          expect(w.getSessionEpoch('sess-1')).toBe(2);

          const older = serializeV2Transaction(
            [
              {
                v: 2,
                type: 'session_reset',
                txId: 'tx-reset-1',
                sessionId: 'sess-1',
                historyEpoch: 1,
                reason: 'legacy_mismatch',
              },
            ],
            {
              txId: 'tx-reset-1',
              createdAt: '2026-06-20T00:00:00.000Z',
              targetPath,
            }
          );
          w.applyCommittedToIndex(w.appendPrepared(older).transaction);
          expect(w.getSessionEpoch('sess-1')).toBe(2);
        });
      } finally {
        writer.close();
      }
    });
  });
});
