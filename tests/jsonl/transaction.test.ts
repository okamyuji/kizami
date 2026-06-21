import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { serializeV2Transaction, validateCommittedTransaction } from '@/jsonl/transaction';
import type { JsonlV2Payload } from '@/jsonl/types';
import type { TurnCheckpointV2 } from '@/checkpoint/types';

function makeCheckpoint(overrides: Partial<TurnCheckpointV2> = {}): TurnCheckpointV2 {
  return {
    sessionId: 'sess-1',
    runtime: 'claude',
    turnKey: 'tk-1',
    sourceOrder: '00000000000000000001',
    observedThrough: { kind: 'source_offset', generation: 0, offset: 100 },
    historyEpoch: 0,
    revision: 1,
    contentHash: 'abc123',
    completedAt: '2026-06-21T00:00:00.000Z',
    projectPath: '/tmp/proj',
    parts: [
      {
        partIndex: 0,
        externalId: 'claude-ext-0',
        content: 'Hello world',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 2,
      },
    ],
    ...overrides,
  };
}

function makePayload(overrides: Partial<TurnCheckpointV2> = {}): JsonlV2Payload {
  return { v: 2, type: 'turn_checkpoint', txId: 'tx-1', ...makeCheckpoint(overrides) };
}

function computeDigest(payloadLines: string[]): string {
  const text = payloadLines.join('\n') + '\n';
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

describe('JSONL v2 transaction', () => {
  describe('serializeV2Transaction', () => {
    it('produces correct record count excluding begin/commit', () => {
      const payload = makePayload();
      const result = serializeV2Transaction([payload], {
        txId: 'tx-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/data.jsonl',
      });

      expect(result.payloadLines).toHaveLength(1);
      expect(result.allLines).toHaveLength(3);
      expect(result.records).toHaveLength(3);

      const commitRecord = result.records[result.records.length - 1];
      expect(commitRecord).toMatchObject({
        v: 2,
        type: 'tx_commit',
        recordCount: 1,
      });
    });

    it('computes payloadDigest as SHA-256 of joined payload lines with trailing newline', () => {
      const payload = makePayload();
      const result = serializeV2Transaction([payload], {
        txId: 'tx-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/data.jsonl',
      });

      const expected = computeDigest(result.payloadLines);
      expect(result.payloadDigest).toBe(expected);
    });

    it('serializes multiple payloads with correct count and digest', () => {
      const payloads: JsonlV2Payload[] = [
        makePayload({ turnKey: 'tk-1' }),
        makePayload({ turnKey: 'tk-2' }),
      ];
      const result = serializeV2Transaction(payloads, {
        txId: 'tx-multi',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/data.jsonl',
      });

      expect(result.payloadLines).toHaveLength(2);
      expect(result.allLines).toHaveLength(4);

      const commit = JSON.parse(result.allLines[3]) as Record<string, unknown>;
      expect(commit.recordCount).toBe(2);
      expect(commit.payloadDigest).toBe(computeDigest(result.payloadLines));
    });

    it('serialization is stable for identical input', () => {
      const payload = makePayload();
      const opts = {
        txId: 'tx-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/d.jsonl',
      };
      const a = serializeV2Transaction([payload], opts);
      const b = serializeV2Transaction([payload], opts);
      expect(a.allLines).toEqual(b.allLines);
      expect(a.payloadDigest).toBe(b.payloadDigest);
    });

    it('includes session_reset payload in multi-record transaction', () => {
      const resetPayload: JsonlV2Payload = {
        v: 2,
        type: 'session_reset',
        txId: 'tx-reset',
        sessionId: 'sess-1',
        historyEpoch: 1,
        reason: 'legacy_mismatch',
      };
      const checkpointPayload = makePayload({ historyEpoch: 1 });
      const result = serializeV2Transaction([resetPayload, checkpointPayload], {
        txId: 'tx-reset',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/data.jsonl',
      });

      expect(result.payloadLines).toHaveLength(2);
      const parsed0 = JSON.parse(result.payloadLines[0]) as Record<string, unknown>;
      expect(parsed0.type).toBe('session_reset');
    });

    it('preserves all checkpoint fields through serialization round-trip', () => {
      const checkpoint = makeCheckpoint({
        parts: [
          {
            partIndex: 0,
            externalId: 'ext-0',
            content: 'line 1',
            role: 'human',
            metadata: { filePaths: ['/a.ts'], toolNames: ['Read'], errorMessages: [] },
            tokenCount: 3,
          },
          {
            partIndex: 1,
            externalId: 'ext-1',
            content: 'line 2',
            role: 'assistant',
            metadata: { filePaths: [], toolNames: [], errorMessages: [] },
            tokenCount: 2,
          },
        ],
      });
      const payload: JsonlV2Payload = {
        v: 2,
        type: 'turn_checkpoint',
        txId: 'tx-1',
        ...checkpoint,
      };
      const result = serializeV2Transaction([payload], {
        txId: 'tx-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/data.jsonl',
      });

      const roundTrip = JSON.parse(result.payloadLines[0]) as typeof payload;
      expect(roundTrip.parts).toEqual(checkpoint.parts);
      expect(roundTrip.turnKey).toBe(checkpoint.turnKey);
      expect(roundTrip.observedThrough).toEqual(checkpoint.observedThrough);
    });
  });

  describe('validateCommittedTransaction', () => {
    it('accepts a valid complete transaction', () => {
      const payload = makePayload();
      const serialized = serializeV2Transaction([payload], {
        txId: 'tx-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/data.jsonl',
      });

      const result = validateCommittedTransaction(
        serialized.allLines[0],
        serialized.payloadLines,
        serialized.allLines[serialized.allLines.length - 1]
      );

      expect(result).toBeDefined();
      expect(result!.txId).toBe('tx-1');
      expect(result!.payloadDigest).toBe(serialized.payloadDigest);
      expect(result!.payloads).toHaveLength(1);
    });

    it('rejects when recordCount does not match payload lines', () => {
      const payload = makePayload();
      const serialized = serializeV2Transaction([payload], {
        txId: 'tx-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/data.jsonl',
      });

      const commitObj = JSON.parse(serialized.allLines[2]) as Record<string, unknown>;
      commitObj.recordCount = 999;
      const badCommitLine = JSON.stringify(commitObj);

      const result = validateCommittedTransaction(
        serialized.allLines[0],
        serialized.payloadLines,
        badCommitLine
      );
      expect(result).toBeUndefined();
    });

    it('rejects when payloadDigest does not match', () => {
      const payload = makePayload();
      const serialized = serializeV2Transaction([payload], {
        txId: 'tx-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/data.jsonl',
      });

      const commitObj = JSON.parse(serialized.allLines[2]) as Record<string, unknown>;
      commitObj.payloadDigest = 'badhash';
      const badCommitLine = JSON.stringify(commitObj);

      const result = validateCommittedTransaction(
        serialized.allLines[0],
        serialized.payloadLines,
        badCommitLine
      );
      expect(result).toBeUndefined();
    });

    it('rejects when txId differs between begin and commit', () => {
      const payload = makePayload();
      const serialized = serializeV2Transaction([payload], {
        txId: 'tx-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/data.jsonl',
      });

      const beginObj = JSON.parse(serialized.allLines[0]) as Record<string, unknown>;
      beginObj.txId = 'tx-different';
      const badBeginLine = JSON.stringify(beginObj);

      const result = validateCommittedTransaction(
        badBeginLine,
        serialized.payloadLines,
        serialized.allLines[2]
      );
      expect(result).toBeUndefined();
    });

    it('rejects incomplete transaction (missing commit)', () => {
      const result = validateCommittedTransaction(
        JSON.stringify({ v: 2, type: 'tx_begin', txId: 'tx-1', createdAt: '2026-01-01T00:00:00Z' }),
        [JSON.stringify(makePayload())],
        ''
      );
      expect(result).toBeUndefined();
    });

    it('rejects malformed JSON in begin line', () => {
      const result = validateCommittedTransaction(
        '{broken json',
        [JSON.stringify(makePayload())],
        JSON.stringify({
          v: 2,
          type: 'tx_commit',
          txId: 'tx-1',
          recordCount: 1,
          payloadDigest: 'x',
          createdAt: '',
        })
      );
      expect(result).toBeUndefined();
    });

    it('rejects non-v2 payload lines', () => {
      const v1Line = JSON.stringify({ v: 1, type: 'chunk', id: 'x' });
      const serialized = serializeV2Transaction([makePayload()], {
        txId: 'tx-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/data.jsonl',
      });

      const commitObj = JSON.parse(serialized.allLines[2]) as Record<string, unknown>;
      const digest = computeDigest([v1Line]);
      commitObj.payloadDigest = digest;
      commitObj.recordCount = 1;

      const result = validateCommittedTransaction(
        serialized.allLines[0],
        [v1Line],
        JSON.stringify(commitObj)
      );
      expect(result).toBeUndefined();
    });

    it('validates multi-payload transaction correctly', () => {
      const payloads: JsonlV2Payload[] = [
        makePayload({ turnKey: 'tk-a' }),
        makePayload({ turnKey: 'tk-b' }),
      ];
      const serialized = serializeV2Transaction(payloads, {
        txId: 'tx-multi',
        createdAt: '2026-06-21T00:00:00.000Z',
        targetPath: '/tmp/data.jsonl',
      });

      const result = validateCommittedTransaction(
        serialized.allLines[0],
        serialized.payloadLines,
        serialized.allLines[serialized.allLines.length - 1]
      );

      expect(result).toBeDefined();
      expect(result!.payloads).toHaveLength(2);
    });
  });
});
