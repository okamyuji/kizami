import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 正本全体を読み直したかを、fold の呼び出し回数で見る
const folds = vi.hoisted(() => ({ count: 0, after: undefined as undefined | (() => void) }));
vi.mock('@/jsonl/fold', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/jsonl/fold')>();
  return {
    ...real,
    foldCanonicalHistory: async (files: string[]) => {
      folds.count += 1;
      const history = await real.foldCanonicalHistory(files);
      folds.after?.();
      return history;
    },
  };
});

// 削除の書き込みを、テストごとに 1 回だけ失敗させる。途中で止まった回の後の動きを見るため
const deletions = vi.hoisted(() => ({ failOnce: false, calls: 0 }));
vi.mock('@/jsonl/deletion', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/jsonl/deletion')>();
  return {
    ...real,
    appendChunkDeletions: (...args: Parameters<typeof real.appendChunkDeletions>) => {
      deletions.calls += 1;
      if (deletions.failOnce) {
        deletions.failOnce = false;
        throw new Error('stopped before the deletions');
      }
      return real.appendChunkDeletions(...args);
    },
  };
});

// 正本へのトランザクションを 1 回だけ失敗させる。DB を直した後に止まった回を作るため
const serialize = vi.hoisted(() => ({ failOnce: false }));
vi.mock('@/jsonl/transaction', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/jsonl/transaction')>();
  return {
    ...real,
    serializeV2Transaction: (...args: Parameters<typeof real.serializeV2Transaction>) => {
      if (serialize.failOnce && args[0].some((p) => p.type === 'turn_checkpoint')) {
        serialize.failOnce = false;
        throw new Error('stopped before the JSONL write');
      }
      return real.serializeV2Transaction(...args);
    },
  };
});

const { repairRequestCopies } = await import('@/hooks/request-copies');
const { getDatabase } = await import('@/db/connection');
const { initializeSchema } = await import('@/db/schema');
const { Store } = await import('@/db/store');
const { getDefaultConfig } = await import('@/config');
const { serializeV2Transaction } = await import('@/jsonl/transaction');
const { foldCanonicalHistory } = await import('@/jsonl/fold');
const { listJsonlFiles } = await import('@/jsonl/path');
const { JsonlTransactionWriter } = await import('@/jsonl/writer');
const { commitCheckpointBatch } = await import('@/checkpoint/coordinator');
const { createPartExternalId } = await import('@/checkpoint/identity');

const COPY = '[User]\n<system-reminder>SECRET</system-reminder>\nq\n\n[Assistant]\na';

describe('repairRequestCopies reads the JSONL store only when it holds something new', () => {
  let tmp: string;
  let jsonlDir: string;
  let file: string;
  let close: () => void;
  let input: Parameters<typeof repairRequestCopies>[0];
  const stateFile = () => path.join(tmp, 'recover-request-copies.json');

  const record = (id: string, sessionId: string, chunkIndex: number, content: string) =>
    JSON.stringify({
      v: 1,
      type: 'chunk',
      id,
      sessionId,
      projectPath: '/p',
      chunkIndex,
      content,
      role: 'mixed',
      metadata: null,
      tokenCount: 1,
      createdAt: '2026-10-16T00:00:00.000Z',
    }) + '\n';
  const add = (target: string, text: string) => fs.appendFileSync(target, text, { mode: 0o600 });
  const run = async () => {
    folds.count = 0;
    const result = await repairRequestCopies(input);
    return { result, folds: folds.count };
  };
  const saveState = (marks: unknown) =>
    fs.writeFileSync(stateFile(), JSON.stringify({ files: marks }));
  const markOf = (target: string, overrides: Record<string, unknown> = {}) => {
    const stat = fs.lstatSync(target);
    return {
      file: path.basename(target),
      identity: `${stat.dev}:${stat.ino}`,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...overrides,
    };
  };
  const legacyContents = async () =>
    (await foldCanonicalHistory(listJsonlFiles(jsonlDir))).legacyChunks.map((c) => c.content);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-copies-scan-'));
    jsonlDir = path.join(tmp, 'jsonl');
    fs.mkdirSync(jsonlDir, { mode: 0o700 });
    file = path.join(jsonlDir, '2026-10-host.jsonl');
    const d = getDefaultConfig();
    const config = {
      ...d,
      database: { path: path.join(tmp, 'memory.db') },
      storage: { ...d.storage, jsonlDir },
    };
    const db = getDatabase(config.database.path);
    initializeSchema(db);
    close = () => db.close();
    input = { config, store: new Store(db), compact: async () => 'unchanged' };
  });
  afterEach(() => {
    close();
    deletions.failOnce = false;
    folds.after = undefined;
    serialize.failOnce = false;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const lockFile = () => path.join(tmp, 'recover-request-copies.lock');
  const checkpoint = (
    sessionId: string,
    content: string,
    revision = 1,
    turnKey = 'tk-1',
    historyEpoch = 0
  ) => ({
    v: 2 as const,
    type: 'turn_checkpoint' as const,
    txId: '',
    sessionId,
    runtime: 'claude' as const,
    turnKey,
    sourceOrder: '1',
    observedThrough: { kind: 'source_offset' as const, generation: 0, offset: 1 },
    historyEpoch,
    revision,
    contentHash: `h${revision}`,
    completedAt: '2026-10-16T00:00:00.000Z',
    projectPath: '/p',
    parts: [
      {
        partIndex: 0,
        // hook が作る part と同じく、ID は位置から決まる
        externalId: createPartExternalId('claude', sessionId, turnKey, 0),
        content,
        role: 'mixed' as const,
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 1,
      },
    ],
  });
  let txCount = 0;
  const tx = (payloads: Parameters<typeof serializeV2Transaction>[0]) =>
    serializeV2Transaction(payloads, {
      txId: `tx-${(txCount += 1)}`,
      createdAt: '2026-10-16T00:00:00.000Z',
      targetPath: file,
    });
  const turnTx = (sessionId: string, content: string, revision = 1, turnKey = 'tk-1') =>
    tx([checkpoint(sessionId, content, revision, turnKey)]);
  const turn = (sessionId: string, content: string, turnKey = 'tk-1') =>
    turnTx(sessionId, content, 1, turnKey).allLines.join('\n') + '\n';
  // 書き手を通して書く。索引も更新されるので、別の hook が書いた revision と同じになる
  const writeThroughWriter = (payloads: Parameters<typeof serializeV2Transaction>[0]) => {
    const writer = new JsonlTransactionWriter(jsonlDir);
    try {
      writer.withExclusiveTransaction((w) => {
        w.applyCommittedToIndex(w.appendPrepared(tx(payloads)).transaction);
      });
    } finally {
      writer.close();
    }
  };

  it('leaves for the next run a v2 turn written again after the store was read', async () => {
    add(file, turn('session-v2-0001', COPY));
    add(file, turn('session-v2-0001', COPY, 'tk-2'));
    folds.after = () => {
      folds.after = undefined;
      writeThroughWriter([
        checkpoint('session-v2-0001', '[User]\nq\n\n[Assistant]\nnewer', 2),
        checkpoint('session-v2-0001', '[User]\nq\n\n[Assistant]\nnewer too', 2, 'tk-2'),
      ]);
    };

    const { result } = await run();

    expect(result).toEqual({
      repaired: 0,
      errors: 1,
      details: ['session-: changed while it was being repaired, checked again next time'],
    });
    expect(fs.existsSync(stateFile())).toBe(false);
    const turns = [...(await foldCanonicalHistory(listJsonlFiles(jsonlDir))).turns.values()];
    expect(turns.map((t) => [t.revision, t.parts[0].content])).toEqual([
      [2, '[User]\nq\n\n[Assistant]\nnewer'],
      [2, '[User]\nq\n\n[Assistant]\nnewer too'],
    ]);
  });

  it('does not count a session whose v2 turn was left even when its v1 turn was fixed', async () => {
    add(file, record('c1', 'session-mixed-1', 0, COPY));
    add(file, turn('session-mixed-1', COPY));
    folds.after = () => {
      folds.after = undefined;
      writeThroughWriter([checkpoint('session-mixed-1', COPY, 2)]);
    };

    const { result } = await run();

    expect(result.repaired).toBe(0);
    expect(result.details).toEqual([
      'session-: changed while it was being repaired, checked again next time',
    ]);
  });

  it('writes over a turn whose index head is from an epoch before a reset it never saw', async () => {
    writeThroughWriter([checkpoint('session-reset-1', '[User]\nold\n\n[Assistant]\nold', 3)]);
    add(
      file,
      tx([
        {
          v: 2,
          type: 'session_reset',
          txId: '',
          sessionId: 'session-reset-1',
          historyEpoch: 1,
          reason: 'legacy_mismatch',
        },
        checkpoint('session-reset-1', COPY, 1, 'tk-1', 1),
      ]).allLines.join('\n') + '\n'
    );

    expect((await run()).result.details).toEqual(['session- (trimmed 1 turn)']);
    const turns = [...(await foldCanonicalHistory(listJsonlFiles(jsonlDir))).turns.values()];
    expect(turns.map((t) => [t.historyEpoch, t.revision, t.parts[0].content])).toEqual([
      [1, 2, '[User]\nq\n\n[Assistant]\na'],
    ]);
  });

  it('writes the content hash a hook would write for the same turn', async () => {
    add(file, turn('session-hash-1', COPY));
    await run();

    const [outcome] = await commitCheckpointBatch(
      {
        runtime: 'claude',
        sessionId: 'session-hash-1',
        candidates: [
          {
            runtime: 'claude',
            sessionId: 'session-hash-1',
            turnKey: 'tk-1',
            sourceOrder: '1',
            observedThrough: { kind: 'source_offset', generation: 0, offset: 1 },
            projectPath: '/p',
            completedAt: '2026-10-16T00:00:00.000Z',
            prompt: 'q',
            assistant: 'a',
            messages: [],
            executions: [],
          },
        ],
        finalization: { pendingPaths: [] },
      },
      input.config
    );

    expect(outcome.status).toBe('already_current');
  });

  it('writes the next revision after the one in the store even when the writer index never saw it', async () => {
    add(file, turn('session-v2-0003', COPY));

    await run();

    const history = await foldCanonicalHistory(listJsonlFiles(jsonlDir));
    expect(history.errors).toEqual([]);
    expect([...history.turns.values()].map((t) => t.revision)).toEqual([2]);
  });

  it('trims a v2 turn and keeps it out of the DB that did not hold it', async () => {
    add(file, turn('session-v2-0002', COPY));

    expect((await run()).result.details).toEqual(['session- (trimmed 1 turn)']);
    const turns = [...(await foldCanonicalHistory(listJsonlFiles(jsonlDir))).turns.values()];
    expect(turns.map((t) => t.parts.map((p) => p.content))).toEqual([
      ['[User]\nq\n\n[Assistant]\na'],
    ]);
  });

  it('keeps a turn with no prompt left when the previous run stopped before the deletions', async () => {
    add(
      file,
      record('c1', 's1', 0, '[User]\n<system-reminder>S</system-reminder>\n\n[Assistant]\na')
    );
    deletions.failOnce = true;
    expect((await run()).result.details).toEqual([
      'v1 rows: error - Error: stopped before the deletions',
    ]);

    await run();

    expect(await legacyContents()).toEqual(['[Assistant]\na']);
  });

  it('fixes the DB before the JSONL store, and finishes the store on the next run', async () => {
    add(file, turn('session-order-1', COPY));
    input.store.applyTurnCheckpoint(checkpoint('session-order-1', COPY));
    serialize.failOnce = true;

    const failed = await run();

    expect(failed.result.details).toEqual([
      'v2 turns: error - Error: stopped before the JSONL write',
    ]);
    const rows = () => input.store.getTurnChunkRefs('session-order-1', 'tk-1');
    expect(rows().map((r) => input.store.getChunk(r.id)!.content)).toEqual([
      '[User]\nq\n\n[Assistant]\na',
    ]);

    expect((await run()).result).toEqual({
      repaired: 1,
      errors: 0,
      details: ['session- (trimmed 1 turn)'],
    });
    const turns = [...(await foldCanonicalHistory(listJsonlFiles(jsonlDir))).turns.values()];
    expect(turns.map((t) => t.parts[0].content)).toEqual(['[User]\nq\n\n[Assistant]\na']);
    // DB はもう同じ中身を持っているので、そのまま残す
    expect(rows().map((r) => input.store.getChunk(r.id)!.content)).toEqual([
      '[User]\nq\n\n[Assistant]\na',
    ]);
  });

  it('fixes the DB rows of a v1 turn before the JSONL store', async () => {
    add(file, record('c1', 's1', 0, COPY));
    input.store.insertChunks([
      {
        externalId: 'c1',
        sessionId: 's1',
        projectPath: '/p',
        chunkIndex: 0,
        content: COPY,
        role: 'mixed',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 1,
      },
    ]);
    deletions.failOnce = true;

    await run();

    const db = input.store;
    expect(db.getChunkIdByExternalId('c1')).toBeUndefined();
    expect(db.getChunk(db.getChunkIdByExternalId('c1-trimmed-0')!)!.content).toBe(
      '[User]\nq\n\n[Assistant]\na'
    );
  });

  const deleteByHand = (sessionId: string, externalId: string) =>
    add(
      file,
      tx([{ v: 2, type: 'chunk_delete', txId: '', sessionId, externalId }]).allLines.join('\n') +
        '\n'
    );

  it('removes the rest of a v1 copy whose first row was deleted by hand', async () => {
    add(file, record('c1', 's1', 0, '[User]\n<system-reminder>head'));
    add(file, record('c2', 's1', 1, 'CLAUDEMD rest\n</system-reminder>\nq\n\n[Assistant]\na'));
    add(file, record('c3', 's1', 2, '[User]\nnext\n\n[Assistant]\nfine'));
    deleteByHand('s1', 'c1');

    expect((await run()).result.details).toEqual(['s1 (trimmed 1 turn)']);
    expect((await legacyContents()).sort()).toEqual([
      '[User]\nnext\n\n[Assistant]\nfine',
      '[User]\nq\n\n[Assistant]\na',
    ]);
  });

  it('removes the rest of a v1 copy whose first row, deleted by hand, came after another turn', async () => {
    add(file, record('c0', 's1', 0, '[User]\nfirst\n\n[Assistant]\nok'));
    add(file, record('c1', 's1', 1, '[User]\n<system-reminder>head'));
    add(file, record('c2', 's1', 2, 'CLAUDEMD rest\n</system-reminder>\nq\n\n[Assistant]\na'));
    add(file, record('c3', 's1', 3, '[User]\nnext\n\n[Assistant]\nfine'));
    deleteByHand('s1', 'c1');

    expect((await run()).result.details).toEqual(['s1 (trimmed 1 turn)']);
    expect((await legacyContents()).sort()).toEqual([
      '[User]\nfirst\n\n[Assistant]\nok',
      '[User]\nnext\n\n[Assistant]\nfine',
      '[User]\nq\n\n[Assistant]\na',
    ]);
  });

  it('removes the rest of a v2 copy whose first part was deleted by hand', async () => {
    const parts = [
      '[User]\n<system-reminder>head',
      'CLAUDEMD rest\n</system-reminder>\nq\n\n[Assistant]\na',
    ];
    const cp = checkpoint('session-hand-1', parts[0]);
    cp.parts = parts.map((content, i) => ({
      ...cp.parts[0],
      partIndex: i,
      externalId: createPartExternalId('claude', 'session-hand-1', 'tk-1', i),
      content,
    }));
    add(file, tx([cp]).allLines.join('\n') + '\n');
    deleteByHand('session-hand-1', cp.parts[0].externalId);

    expect((await run()).result.details).toEqual(['session- (trimmed 1 turn)']);
    const text = JSON.stringify([
      ...(await foldCanonicalHistory(listJsonlFiles(jsonlDir))).turns.values(),
    ]);
    expect(text).not.toContain('CLAUDEMD');
  });

  it('does not take as a copy a turn whose copied revision was already replaced', async () => {
    add(file, turn('session-done-1', COPY));
    await run();
    fs.rmSync(stateFile());

    expect((await run()).result.details).toEqual([]);
  });

  it('leaves the lock of another process that took it over', async () => {
    add(file, record('c1', 's1', 0, COPY));
    input.compact = async () => {
      fs.writeFileSync(lockFile(), '999999');
      return 'unchanged';
    };

    await run();

    expect(fs.readFileSync(lockFile(), 'utf-8')).toBe('999999');
  });

  it('reads again on the next run what was appended while it was repairing', async () => {
    add(file, record('c1', 's1', 0, COPY));
    folds.after = () => {
      folds.after = undefined;
      add(path.join(jsonlDir, '2026-11-host.jsonl'), record('c9', 's9', 0, COPY));
    };
    await run();

    expect((await run()).result.details).toEqual(['s9 (trimmed 1 turn)']);
  });

  it('reports the v2 sessions it fixed even when writing the v1 rows failed', async () => {
    add(file, turn('session-v2-ok-1', COPY));
    add(file, record('c1', 's1', 0, COPY));
    deletions.failOnce = true;

    const { result } = await run();

    expect(result.details).toEqual([
      'v1 rows: error - Error: stopped before the deletions',
      'session- (trimmed 1 turn)',
    ]);
    expect(result.repaired).toBe(1);
  });

  it('takes over a lock older than ten minutes even when its process id is in use', async () => {
    add(file, record('c1', 's1', 0, COPY));
    fs.writeFileSync(lockFile(), String(process.pid));
    const old = new Date(Date.now() - 10 * 60 * 1000 - 1000);
    fs.utimesSync(lockFile(), old, old);

    expect((await run()).result.repaired).toBe(1);
  });

  it('keeps a lock exactly ten minutes old', async () => {
    add(file, record('c1', 's1', 0, COPY));
    fs.writeFileSync(lockFile(), String(process.pid));
    const now = new Date('2026-10-17T12:00:00.000Z');
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    fs.utimesSync(lockFile(), tenMinutesAgo, tenMinutesAgo);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now);

      expect((await run()).folds).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the store to a process it may not signal, since that one is running', async () => {
    add(file, record('c1', 's1', 0, COPY));
    fs.writeFileSync(lockFile(), '1');

    expect((await run()).folds).toBe(0);
  });

  it('does not fail when the lock is already gone at the end', async () => {
    add(file, record('c1', 's1', 0, COPY));
    input.compact = async () => {
      fs.rmSync(lockFile());
      return 'unchanged';
    };

    expect((await run()).result.repaired).toBe(1);
  });

  it('leaves at the end a lock path it cannot read as its own', async () => {
    add(file, record('c1', 's1', 0, COPY));
    input.compact = async () => {
      fs.rmSync(lockFile());
      fs.mkdirSync(lockFile());
      return 'unchanged';
    };

    expect((await run()).result.repaired).toBe(1);
    expect(fs.statSync(lockFile()).isDirectory()).toBe(true);
  });

  it('fails when the lock cannot be created at all', async () => {
    add(file, record('c1', 's1', 0, COPY));
    input.config = {
      ...input.config,
      database: { path: path.join(tmp, 'missing', 'memory.db') },
    };

    await expect(repairRequestCopies(input)).rejects.toThrow(/ENOENT/);
  });

  it('writes the deletions of all v1 turns as one transaction', async () => {
    add(file, record('c1', 's1', 0, COPY));
    add(file, record('c2', 's2', 0, COPY));
    deletions.calls = 0;

    expect((await run()).result.repaired).toBe(2);
    expect(deletions.calls).toBe(1);
  });

  it('does not write a v1 turn twice when the previous run stopped before the deletions', async () => {
    add(file, record('c1', 's1', 0, COPY));
    add(file, record('c2', 's1', 1, '[User]\nnext\n\n[Assistant]\nfine'));
    deletions.failOnce = true;
    const failed = await run();
    expect(failed.result.errors).toBe(1);
    expect(fs.existsSync(stateFile())).toBe(false);

    await run();

    expect((await legacyContents()).sort()).toEqual([
      '[User]\nnext\n\n[Assistant]\nfine',
      '[User]\nq\n\n[Assistant]\na',
    ]);
  });

  it('leaves the store to another live process that holds the lock', async () => {
    add(file, record('c1', 's1', 0, COPY));
    fs.writeFileSync(lockFile(), String(process.pid));

    const { result, folds: count } = await run();

    expect(count).toBe(0);
    expect(result).toEqual({ repaired: 0, errors: 0, details: [] });
    expect(fs.existsSync(stateFile())).toBe(false);
    expect(fs.readFileSync(lockFile(), 'utf-8')).toBe(String(process.pid));
  });

  it.each([
    ['a process that has ended', '2147483646'],
    ['no process id', 'garbage'],
  ])('takes over a lock left by %s and releases it', async (_n, holder) => {
    add(file, record('c1', 's1', 0, COPY));
    fs.writeFileSync(lockFile(), holder);

    expect((await run()).result.repaired).toBe(1);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('releases the lock when the repair fails', async () => {
    add(file, record('c1', 's1', 0, COPY));
    deletions.failOnce = true;

    await run();

    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('reads the whole store on the first run and not again while nothing changed', async () => {
    add(file, record('c1', 's1', 0, '[User]\nplain'));
    const compact = vi.fn(async () => 'unchanged' as const);
    input.compact = compact;

    expect((await run()).folds).toBe(1);
    expect((await run()).folds).toBe(0);
    expect(compact).not.toHaveBeenCalled();
  });

  it('does not read again an unchanged file that quotes the mark inside a turn', async () => {
    add(file, record('c1', 's1', 0, 'see [User]\n<system-reminder> quoted'));

    expect((await run()).folds).toBe(1);
    expect((await run()).folds).toBe(0);
  });

  it('counts each copied turn of a session and drops a turn that held only reminders', async () => {
    add(file, record('c1', 's1', 0, COPY));
    add(file, record('c2', 's1', 1, '[User]\nplain\n\n[Assistant]\nfine'));
    add(file, record('c3', 's1', 2, '[User]\n<system-reminder>x</system-reminder>'));

    expect((await run()).result.details).toEqual(['s1 (trimmed 2 turns)']);
    expect((await legacyContents()).sort()).toEqual([
      '[User]\nplain\n\n[Assistant]\nfine',
      '[User]\nq\n\n[Assistant]\na',
    ]);
  });

  it('reads only what was appended, and records the new size', async () => {
    add(file, record('c1', 's1', 0, '[User]\nplain'));
    await run();
    add(file, record('c2', 's1', 1, '[User]\nmore'));

    expect((await run()).folds).toBe(0);
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf-8')).files).toEqual([markOf(file)]);
  });

  it('finds a copy whose mark crosses the end of the part read before', async () => {
    add(file, record('c1', 's1', 0, COPY));
    const text = fs.readFileSync(file, 'utf-8');
    saveState([markOf(file, { size: text.indexOf('<system-reminder>') - 2, mtimeMs: 0 })]);

    const { result, folds: count } = await run();

    expect(count).toBe(1);
    expect(result.details).toEqual(['s1 (trimmed 1 turn)']);
  });

  it('does not read again the part before the previous end', async () => {
    add(file, record('c1', 's1', 0, COPY));
    const before = markOf(file);
    add(file, record('c2', 's2', 0, '[User]\nplain'));
    saveState([before]);

    expect((await run()).folds).toBe(0);
  });

  it('reads the whole file when it was rewritten in place to the same size', async () => {
    add(file, record('c1', 's1', 0, COPY));
    saveState([markOf(file, { mtimeMs: 0 })]);

    expect((await run()).folds).toBe(1);
  });

  it('reads the whole file when it shrank', async () => {
    add(file, record('c1', 's1', 0, COPY));
    saveState([markOf(file, { size: fs.statSync(file).size + 10 })]);

    expect((await run()).folds).toBe(1);
  });

  it('reads the whole file when it was replaced by another one', async () => {
    add(file, record('c1', 's1', 0, COPY));
    saveState([markOf(file, { identity: 'other' })]);

    expect((await run()).folds).toBe(1);
  });

  it('reads a new file only when it holds the mark', async () => {
    saveState([]);
    add(file, record('c1', 's1', 0, '[User]\nplain'));
    expect((await run()).folds).toBe(0);

    add(path.join(jsonlDir, '2026-11-host.jsonl'), record('c2', 's2', 0, COPY));
    expect((await run()).folds).toBe(1);
  });

  it('does not take a backslash and an n written as text for the mark', async () => {
    saveState([]);
    add(file, record('c1', 's1', 0, '[User]\\n<system-reminder> as text'));

    expect((await run()).folds).toBe(0);
  });

  it('groups v1 rows by their chunk index, not by their order in the file', async () => {
    add(file, record('c3', 's1', 2, '[User]\nnext question\n\n[Assistant]\nnext answer'));
    add(file, record('c2', 's1', 1, 'SECRET tail\n</system-reminder>\nq\n\n[Assistant]\na'));
    add(file, record('c1', 's1', 0, '[User]\n<system-reminder>head'));

    await run();

    const contents = await legacyContents();
    expect(contents.sort()).toEqual([
      '[User]\nnext question\n\n[Assistant]\nnext answer',
      '[User]\nq\n\n[Assistant]\na',
    ]);
  });

  it('refuses a store with invalid transactions and saves nothing', async () => {
    const tx = (content: string) =>
      serializeV2Transaction(
        [{ v: 2, type: 'chunk_delete', txId: '', sessionId: 's1', externalId: content }],
        { txId: 'same', createdAt: '2026-10-16T00:00:00.000Z', targetPath: file }
      ).allLines;
    add(file, [...tx('a'), ...tx('b'), ...tx('c'), ''].join('\n') + record('c1', 's1', 0, COPY));

    await expect(repairRequestCopies(input)).rejects.toThrow(
      /invalid transactions, so nothing was repaired: duplicate transaction ID has a different payload digest; duplicate/
    );
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it('reports each session it could not fix and saves nothing', async () => {
    add(file, record('c1', 'session-one', 0, COPY));
    add(file, record('c2', 'session-two', 0, COPY));
    // DB を閉じておき、正本は読めても直す処理だけが失敗するようにする
    close();
    close = () => {};

    const { result } = await run();

    expect(result.errors).toBe(4);
    expect(result.details).toEqual([
      expect.stringMatching(/^session-: error - /),
      expect.stringMatching(/^session-: error - /),
      expect.stringMatching(/^session summaries: error - /),
      expect.stringMatching(/^full-text index: error - /),
    ]);
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it('saves nothing when only the session summaries could not be fixed', async () => {
    add(file, record('c1', 'session-one', 0, COPY));
    vi.spyOn(input.store, 'sessionsWithSummaryContaining').mockImplementationOnce(() => {
      throw new Error('summaries failed');
    });

    const { result } = await run();

    expect(result.details).toEqual([
      'session- (trimmed 1 turn)',
      'session summaries: error - Error: summaries failed',
    ]);
    expect(fs.existsSync(stateFile())).toBe(false);
  });
});
