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
import { updatePreparedPhase } from '@/checkpoint/state';
import type { PreparedCheckpointV2 } from '@/checkpoint/state';

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
  fs.mkdirSync(jsonlDir, { recursive: true, mode: 0o700 });
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

function receiptContainsReset(receipt: PreparedCheckpointV2): boolean {
  return receipt.allLines.slice(1, -1).some((line) => {
    const parsed: unknown = JSON.parse(line);
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      parsed.type === 'session_reset'
    );
  });
}

describe('recoverPreparedCheckpoints', () => {
  it('returns zeros when no prepared receipts exist', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    const result = await recoverPreparedCheckpoints(config);
    expect(result).toEqual({ finalized: 0, superseded: 0, failed: 0 });
  });

  it('is a no-op when receipts are already finalized', async () => {
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

    const result = await recoverPreparedCheckpoints(config, 'claude');
    expect(result).toEqual({ finalized: 0, superseded: 0, failed: 0 });
  });

  it('reapplies a committed non-reset receipt incrementally', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [makeCandidate()],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const preparedDir = path.join(dir, 'prepared', 'claude');
    const receiptPath = path.join(preparedDir, fs.readdirSync(preparedDir)[0]);
    updatePreparedPhase(receiptPath, 'jsonl_committed');
    const db = getDatabase(config.database.path);
    const store = new Store(db);
    store.truncateAll();
    store.applyTurnCheckpoint({
      sessionId: 'sess-1',
      runtime: 'claude',
      turnKey: 'existing-turn',
      sourceOrder: '00000000000000000000',
      observedThrough: { kind: 'source_offset', generation: 0, offset: 1 },
      historyEpoch: 0,
      revision: 1,
      contentHash: 'existing-content',
      completedAt: '2026-06-20T00:00:00.000Z',
      projectPath: '/tmp/proj',
      parts: [
        {
          partIndex: 0,
          externalId: 'existing-part',
          content: 'existing',
          role: 'assistant',
          metadata: { filePaths: [], toolNames: [], errorMessages: [] },
          tokenCount: 1,
        },
      ],
    });
    db.close();

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 1, superseded: 0, failed: 0 });
    const recoveredDb = getDatabase(config.database.path);
    const recoveredStore = new Store(recoveredDb);
    expect(recoveredStore.getStoredTurnState('sess-1', 'existing-turn')).toBeDefined();
    expect(recoveredStore.getStoredTurnState('sess-1', 'tk-1')).toBeDefined();
    recoveredDb.close();
  });

  it('rebuilds SQLite from validated allLines instead of mutable receipt records', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [makeCandidate()],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const preparedDir = path.join(dir, 'prepared', 'claude');
    const receiptPath = path.join(preparedDir, fs.readdirSync(preparedDir)[0]);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8')) as PreparedCheckpointV2;
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({ ...receipt, phase: 'jsonl_committed', records: [], turnKeys: [] })
    );

    const db = getDatabase(config.database.path);
    const store = new Store(db);
    store.truncateAll();
    db.close();

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 1, superseded: 0, failed: 0 });
    const recoveredDb = getDatabase(config.database.path);
    const recoveredStore = new Store(recoveredDb);
    expect(recoveredStore.getStoredTurnState('sess-1', 'tk-1')).toBeDefined();
    recoveredDb.close();
  });

  it('fails closed when receipt allLines no longer match the payload digest', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [makeCandidate()],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const preparedDir = path.join(dir, 'prepared', 'claude');
    const receiptPath = path.join(preparedDir, fs.readdirSync(preparedDir)[0]);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8')) as PreparedCheckpointV2;
    const payload = JSON.parse(receipt.allLines[1]) as Record<string, unknown>;
    payload['projectPath'] = '/tampered';
    const allLines = [...receipt.allLines];
    allLines[1] = JSON.stringify(payload);
    fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, allLines }));

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 0, superseded: 0, failed: 1 });
    expect(fs.existsSync(receiptPath)).toBe(true);
  });

  it('does not delete a pending path outside the runtime pending directory', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [makeCandidate()],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const victimPath = path.join(dir, 'do-not-delete.json');
    fs.writeFileSync(victimPath, '{}');
    const preparedDir = path.join(dir, 'prepared', 'claude');
    const receiptPath = path.join(preparedDir, fs.readdirSync(preparedDir)[0]);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8')) as PreparedCheckpointV2;
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        ...receipt,
        phase: 'jsonl_committed',
        finalization: { ...receipt.finalization, pendingPaths: [victimPath] },
      })
    );

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 0, superseded: 0, failed: 1 });
    expect(fs.readFileSync(victimPath, 'utf-8')).toBe('{}');
  });

  it('never deletes a pending file during receipt recovery', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [makeCandidate()],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const pendingDir = path.join(dir, 'pending', 'claude');
    fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
    const unrelatedPendingPath = path.join(pendingDir, 'unrelated.json');
    fs.writeFileSync(unrelatedPendingPath, '{"sessionId":"another-session"}');
    const preparedDir = path.join(dir, 'prepared', 'claude');
    const receiptPath = path.join(preparedDir, fs.readdirSync(preparedDir)[0]);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8')) as PreparedCheckpointV2;
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        ...receipt,
        phase: 'jsonl_committed',
        finalization: { ...receipt.finalization, pendingPaths: [unrelatedPendingPath] },
      })
    );

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 1, superseded: 0, failed: 0 });
    expect(fs.existsSync(unrelatedPendingPath)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked prepared runtime directory',
    async () => {
      const dir = makeTmpDir();
      const config = makeConfig(dir);
      const outside = makeTmpDir();
      const preparedRoot = path.join(dir, 'prepared');
      fs.mkdirSync(preparedRoot, { recursive: true, mode: 0o700 });
      fs.symlinkSync(outside, path.join(preparedRoot, 'claude'));

      await expect(recoverPreparedCheckpoints(config, 'claude')).rejects.toThrow(/symlink/);
    }
  );

  it('rejects a receipt stored under a different runtime directory', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    await commitCheckpointBatch(
      {
        runtime: 'codex',
        sessionId: 'sess-1',
        candidates: [makeCandidate({ runtime: 'codex' })],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const codexDir = path.join(dir, 'prepared', 'codex');
    const claudeDir = path.join(dir, 'prepared', 'claude');
    fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    const sourcePath = path.join(codexDir, fs.readdirSync(codexDir)[0]);
    const misplacedPath = path.join(claudeDir, path.basename(sourcePath));
    fs.renameSync(sourcePath, misplacedPath);
    updatePreparedPhase(misplacedPath, 'jsonl_committed');

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 0, superseded: 0, failed: 1 });
    expect(fs.existsSync(misplacedPath)).toBe(true);
  });

  it('rejects a prepared receipt before reading it when the file exceeds 64 MiB', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    const preparedDir = path.join(dir, 'prepared', 'claude');
    fs.mkdirSync(preparedDir, { recursive: true, mode: 0o700 });
    const receiptPath = path.join(preparedDir, 'oversized.json');
    fs.writeFileSync(receiptPath, '{}', { mode: 0o600 });
    fs.truncateSync(receiptPath, 64 * 1024 * 1024 + 1);

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 0, superseded: 0, failed: 1 });
  });

  it('rejects a receipt containing more than 4096 payload records', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    const preparedDir = path.join(dir, 'prepared', 'claude');
    fs.mkdirSync(preparedDir, { recursive: true, mode: 0o700 });
    const receiptPath = path.join(preparedDir, 'too-many-records.json');
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        version: 2,
        phase: 'prepared',
        txId: 'tx-many',
        runtime: 'claude',
        sessionId: 'sess-1',
        targetPath: path.join(config.storage.jsonlDir, '2026-08-host.jsonl'),
        payloadDigest: 'digest',
        allLines: Array.from({ length: 4099 }, () => '{}'),
        finalization: { pendingPaths: [] },
      }),
      { mode: 0o600 }
    );

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 0, superseded: 0, failed: 1 });
  });

  it('rejects a receipt containing a JSONL line larger than 4 MiB', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [makeCandidate()],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const preparedDir = path.join(dir, 'prepared', 'claude');
    const receiptPath = path.join(preparedDir, fs.readdirSync(preparedDir)[0]);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8')) as PreparedCheckpointV2;
    const allLines = [...receipt.allLines];
    allLines[1] = 'x'.repeat(4 * 1024 * 1024 + 1);
    fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, allLines }));

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 0, superseded: 0, failed: 1 });
  });

  it('reapplies a committed reset receipt as a baseline instead of retaining an old epoch', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        resetReason: 'legacy_mismatch',
        candidates: [
          makeCandidate({
            turnKey: 'new-success',
            sourceOrder: '00000000000000000002',
            executions: [
              {
                executionIndex: 0,
                toolName: 'Bash',
                command: 'pnpm test',
                status: 'succeeded',
                outputExcerpt: 'passed',
              },
            ],
          }),
        ],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const preparedDir = path.join(dir, 'prepared', 'claude');
    const resetReceiptPath = fs
      .readdirSync(preparedDir)
      .map((name) => path.join(preparedDir, name))
      .find((filePath) => {
        const receipt = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PreparedCheckpointV2;
        return receiptContainsReset(receipt);
      });
    expect(resetReceiptPath).toBeDefined();
    updatePreparedPhase(resetReceiptPath!, 'jsonl_committed');

    const db = getDatabase(config.database.path);
    db.exec(`
      DELETE FROM verified_error_resolutions;
      DELETE FROM execution_observations;
      DELETE FROM chunks;
      DELETE FROM sessions;
    `);
    db.prepare(
      `INSERT INTO execution_observations (
         runtime, session_id, project_path, turn_key, source_order, history_epoch, revision,
         execution_index, tool_name, command, status, output_excerpt, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'claude',
      'sess-1',
      '/tmp/proj',
      'old-failure',
      '00000000000000000001',
      0,
      1,
      0,
      'Bash',
      'pnpm test',
      'failed',
      'failed',
      '2026-06-20T00:00:00.000Z'
    );
    db.close();

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 1, superseded: 0, failed: 0 });
    const recoveredDb = getDatabase(config.database.path);
    const recoveredStore = new Store(recoveredDb);
    expect(recoveredStore.getExecutionObservations('sess-1')).toMatchObject([
      { turnKey: 'new-success', historyEpoch: 1, status: 'succeeded' },
    ]);
    expect(recoveredStore.searchVerifiedResolutions(undefined, '/tmp/proj')).toEqual([]);
    recoveredDb.close();
  });

  it('leaves an uncommitted reset receipt out of canonical storage until source replay', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        resetReason: 'legacy_mismatch',
        candidates: [
          makeCandidate({
            turnKey: 'new-success',
            sourceOrder: '00000000000000000002',
            executions: [
              {
                executionIndex: 0,
                toolName: 'Bash',
                command: 'pnpm test',
                status: 'succeeded',
                outputExcerpt: 'passed',
              },
            ],
          }),
        ],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const preparedDir = path.join(dir, 'prepared', 'claude');
    const resetReceiptPath = fs
      .readdirSync(preparedDir)
      .map((name) => path.join(preparedDir, name))
      .find((filePath) => {
        const receipt = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PreparedCheckpointV2;
        return receiptContainsReset(receipt);
      });
    expect(resetReceiptPath).toBeDefined();
    const receipt = JSON.parse(fs.readFileSync(resetReceiptPath!, 'utf-8')) as PreparedCheckpointV2;
    updatePreparedPhase(resetReceiptPath!, 'prepared');
    fs.rmSync(receipt.targetPath, { force: true });
    for (const name of fs.readdirSync(config.storage.jsonlDir)) {
      if (name.startsWith('.writer-lock.sqlite')) {
        fs.rmSync(path.join(config.storage.jsonlDir, name), { force: true });
      }
    }

    const db = getDatabase(config.database.path);
    db.exec(`
      DELETE FROM verified_error_resolutions;
      DELETE FROM execution_observations;
      DELETE FROM chunks;
      DELETE FROM sessions;
    `);
    db.prepare(
      `INSERT INTO execution_observations (
         runtime, session_id, project_path, turn_key, source_order, history_epoch, revision,
         execution_index, tool_name, command, status, output_excerpt, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'claude',
      'sess-1',
      '/tmp/proj',
      'old-failure',
      '00000000000000000001',
      0,
      1,
      0,
      'Bash',
      'pnpm test',
      'failed',
      'failed',
      '2026-06-20T00:00:00.000Z'
    );
    db.close();

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 0, superseded: 1, failed: 0 });
    const recoveredDb = getDatabase(config.database.path);
    const recoveredStore = new Store(recoveredDb);
    expect(recoveredStore.getExecutionObservations('sess-1')).toMatchObject([
      { turnKey: 'old-failure', historyEpoch: 0, status: 'failed' },
    ]);
    expect(recoveredStore.searchVerifiedResolutions(undefined, '/tmp/proj')).toEqual([]);
    recoveredDb.close();
    const supersededReceipt = JSON.parse(
      fs.readFileSync(resetReceiptPath!, 'utf-8')
    ) as PreparedCheckpointV2;
    expect(supersededReceipt).toMatchObject({
      phase: 'superseded',
      supersededReason: 'uncommitted receipt requires source replay',
    });

    const nextResult = await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        resetReason: 'legacy_mismatch',
        candidates: [
          makeCandidate({
            turnKey: 'new-success',
            sourceOrder: '00000000000000000003',
            observedThrough: { kind: 'source_offset', generation: 1, offset: 200 },
            executions: [
              {
                executionIndex: 0,
                toolName: 'Bash',
                command: 'pnpm test',
                status: 'succeeded',
                outputExcerpt: 'passed',
              },
            ],
          }),
        ],
        finalization: { pendingPaths: [] },
      },
      config
    );
    expect(nextResult).toMatchObject([{ status: 'inserted', turnKey: 'new-success' }]);
    const nextDb = getDatabase(config.database.path);
    const nextStore = new Store(nextDb);
    expect(nextStore.getStoredTurnState('sess-1', 'new-success')).toMatchObject({
      historyEpoch: 1,
    });
    nextDb.close();
  });

  it('does not let an old-epoch receipt restore a turn omitted by a newer baseline', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [makeCandidate({ turnKey: 'old-turn' })],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const preparedDir = path.join(dir, 'prepared', 'claude');
    const oldReceiptPath = path.join(preparedDir, fs.readdirSync(preparedDir)[0]);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        resetReason: 'legacy_mismatch',
        candidates: [
          makeCandidate({
            turnKey: 'new-turn',
            sourceOrder: '00000000000000000002',
            observedThrough: { kind: 'source_offset', generation: 1, offset: 200 },
          }),
        ],
        finalization: { pendingPaths: [] },
      },
      config
    );
    updatePreparedPhase(oldReceiptPath, 'jsonl_committed');

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 0, superseded: 1, failed: 0 });
    const db = getDatabase(config.database.path);
    const store = new Store(db);
    expect(store.getStoredTurnState('sess-1', 'old-turn')).toBeUndefined();
    expect(store.getStoredTurnState('sess-1', 'new-turn')).toMatchObject({ historyEpoch: 1 });
    db.close();
  });

  it('does not let an old committed receipt roll back the coordination turn head', async () => {
    const dir = makeTmpDir();
    const config = makeConfig(dir);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [makeCandidate({ assistant: 'revision one' })],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const preparedDir = path.join(dir, 'prepared', 'claude');
    const oldReceiptPath = path.join(preparedDir, fs.readdirSync(preparedDir)[0]);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [
          makeCandidate({
            assistant: 'revision two',
            observedThrough: { kind: 'source_offset', generation: 0, offset: 200 },
          }),
        ],
        finalization: { pendingPaths: [] },
      },
      config
    );
    updatePreparedPhase(oldReceiptPath, 'jsonl_committed');

    expect(await recoverPreparedCheckpoints(config, 'claude')).toEqual({
      finalized: 1,
      superseded: 0,
      failed: 0,
    });

    const result = await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        candidates: [
          makeCandidate({
            assistant: 'revision three',
            observedThrough: { kind: 'source_offset', generation: 0, offset: 300 },
          }),
        ],
        finalization: { pendingPaths: [] },
      },
      config
    );
    expect(result).toMatchObject([{ status: 'inserted', turnKey: 'tk-1', revision: 3 }]);
  });

  it('does not append an uncommitted reset receipt when only an old turn head exists', async () => {
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

    const jsonlPath = path.join(
      config.storage.jsonlDir,
      fs.readdirSync(config.storage.jsonlDir).find((name) => name.endsWith('.jsonl'))!
    );
    const beforeReset = fs.readFileSync(jsonlPath);
    await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'sess-1',
        resetReason: 'legacy_mismatch',
        candidates: [candidate],
        finalization: { pendingPaths: [] },
      },
      config
    );

    const preparedDir = path.join(dir, 'prepared', 'claude');
    const resetReceiptPath = fs
      .readdirSync(preparedDir)
      .map((name) => path.join(preparedDir, name))
      .find((filePath) => {
        const receipt = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PreparedCheckpointV2;
        return receiptContainsReset(receipt);
      });
    expect(resetReceiptPath).toBeDefined();
    updatePreparedPhase(resetReceiptPath!, 'prepared');
    fs.writeFileSync(jsonlPath, beforeReset);

    const lockDb = getDatabase(path.join(config.storage.jsonlDir, '.writer-lock.sqlite'));
    lockDb
      .prepare('UPDATE turn_heads SET history_epoch = 0 WHERE session_id = ? AND turn_key = ?')
      .run('sess-1', 'tk-1');
    lockDb.close();

    const result = await recoverPreparedCheckpoints(config, 'claude');

    expect(result).toEqual({ finalized: 0, superseded: 1, failed: 0 });
    expect(fs.readFileSync(jsonlPath)).toEqual(beforeReset);
    const supersededReceipt = JSON.parse(
      fs.readFileSync(resetReceiptPath!, 'utf-8')
    ) as PreparedCheckpointV2;
    expect(supersededReceipt).toMatchObject({
      phase: 'superseded',
      supersededReason: 'uncommitted receipt requires source replay',
    });
  });
});
