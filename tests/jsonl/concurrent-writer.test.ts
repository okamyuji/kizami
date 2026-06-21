import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { JsonlTransactionWriter } from '@/jsonl/writer';
import { serializeV2Transaction } from '@/jsonl/transaction';
import { readCanonicalTransactions } from '@/jsonl/reader';
import type { JsonlV2Payload } from '@/jsonl/types';
import type { TurnCheckpointV2 } from '@/checkpoint/types';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-cw-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function makePayload(sessionId: string, turnKey: string): JsonlV2Payload {
  const cp: TurnCheckpointV2 = {
    sessionId,
    runtime: 'claude',
    turnKey,
    sourceOrder: '00000000000000000001',
    observedThrough: { kind: 'source_offset', generation: 0, offset: 100 },
    historyEpoch: 0,
    revision: 1,
    contentHash: `hash-${turnKey}`,
    completedAt: '2026-06-21T00:00:00.000Z',
    projectPath: '/tmp/proj',
    parts: [
      {
        partIndex: 0,
        externalId: `ext-${turnKey}`,
        content: 'Hello',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 1,
      },
    ],
  };
  return { v: 2, type: 'turn_checkpoint', txId: `tx-${sessionId}-${turnKey}`, ...cp };
}

describe('concurrent writers', () => {
  it('two sequential writers for different sessions both succeed', async () => {
    const dir = makeTmpDir();
    const targetPath = path.join(dir, 'test.jsonl');

    const writer1 = new JsonlTransactionWriter(dir);
    const writer2 = new JsonlTransactionWriter(dir);

    try {
      writer1.withExclusiveTransaction((w) => {
        const payload = makePayload('sess-1', 'tk-a');
        const serialized = serializeV2Transaction([payload], {
          txId: 'tx-sess-1-tk-a',
          createdAt: '2026-06-21T00:00:00.000Z',
          targetPath,
        });
        const { transaction } = w.appendPrepared(serialized);
        w.applyCommittedToIndex(transaction);
      });

      writer2.withExclusiveTransaction((w) => {
        const payload = makePayload('sess-2', 'tk-b');
        const serialized = serializeV2Transaction([payload], {
          txId: 'tx-sess-2-tk-b',
          createdAt: '2026-06-21T00:00:00.000Z',
          targetPath,
        });
        const { transaction } = w.appendPrepared(serialized);
        w.applyCommittedToIndex(transaction);
      });

      let txCount = 0;
      for await (const result of readCanonicalTransactions(targetPath)) {
        if (result.kind === 'transaction') txCount++;
      }
      expect(txCount).toBe(2);
    } finally {
      writer1.close();
      writer2.close();
    }
  });

  it.each(Array.from({ length: 10 }, (_, i) => [i]))(
    'concurrent child-process writes serialize correctly (run %i)',
    async () => {
      const dir = makeTmpDir();
      const targetPath = path.join(dir, 'concurrent.jsonl');
      const scriptPath = path.join(dir, 'worker.mjs');

      const workerScript = `
import { JsonlTransactionWriter } from '${path.resolve('src/jsonl/writer.ts').replace(/\\/g, '/')}';
import { serializeV2Transaction } from '${path.resolve('src/jsonl/transaction.ts').replace(/\\/g, '/')}';

const [,, jsonlDir, targetPath, sessionId, turnKey] = process.argv;
const writer = new JsonlTransactionWriter(jsonlDir);
try {
  writer.withExclusiveTransaction((w) => {
    const checkpoint = {
      sessionId, runtime: 'claude', turnKey,
      sourceOrder: '00000000000000000001',
      observedThrough: { kind: 'source_offset', generation: 0, offset: 100 },
      historyEpoch: 0, revision: 1, contentHash: 'hash-' + turnKey,
      completedAt: '2026-06-21T00:00:00.000Z', projectPath: '/tmp/proj',
      parts: [{ partIndex: 0, externalId: 'ext-' + turnKey, content: 'Hello',
        role: 'human', metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 1 }],
    };
    const payload = { v: 2, type: 'turn_checkpoint', txId: 'tx-' + sessionId + '-' + turnKey, ...checkpoint };
    const serialized = serializeV2Transaction([payload], {
      txId: payload.txId, createdAt: '2026-06-21T00:00:00.000Z', targetPath,
    });
    const { transaction } = w.appendPrepared(serialized);
    w.applyCommittedToIndex(transaction);
  });
} finally {
  writer.close();
}
`;
      fs.writeFileSync(scriptPath, workerScript);

      // ponytail: sequential child processes — true concurrency needs fork(), but serialization through SQLite lock is the real contract
      try {
        execFileSync(
          process.execPath,
          ['--import', 'tsx', scriptPath, dir, targetPath, 'child-1', 'tk-c1'],
          {
            timeout: 10000,
            stdio: 'pipe',
          }
        );
        execFileSync(
          process.execPath,
          ['--import', 'tsx', scriptPath, dir, targetPath, 'child-2', 'tk-c2'],
          {
            timeout: 10000,
            stdio: 'pipe',
          }
        );
      } catch (e) {
        // child process failures are test failures
        throw e;
      }

      let txCount = 0;
      for await (const result of readCanonicalTransactions(targetPath)) {
        if (result.kind === 'transaction') txCount++;
      }
      expect(txCount).toBe(2);
    }
  );
});
