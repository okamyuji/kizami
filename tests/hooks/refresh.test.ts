import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultConfig } from '../../src/config';
import type { EngramConfig } from '../../src/config';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';
import { Store } from '../../src/db/store';
import { loadRecoverMarks, saveRecoverMarks, refreshIfGrown } from '../../src/hooks/refresh';
import { contentDigest } from '../../src/archive/deletions';
import { createTurnKey } from '../../src/checkpoint/identity';
import { writePendingPrompt } from '../../src/checkpoint/state';

describe('recover marks', () => {
  let tmp: string;
  let config: EngramConfig;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-marks-'));
    const d = getDefaultConfig();
    config = { ...d, database: { path: path.join(tmp, 'memory.db') } };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('is empty when no state file exists', () => {
    expect([...loadRecoverMarks(config)]).toEqual([]);
  });

  it('round-trips sizes through recover-state.json next to the DB', () => {
    saveRecoverMarks(
      config,
      new Map([
        ['s1', 10],
        ['s2', 20],
      ])
    );
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'recover-state.json'), 'utf-8'))).toEqual({
      sizes: { s1: 10, s2: 20 },
    });
    expect([...loadRecoverMarks(config)]).toEqual([
      ['s1', 10],
      ['s2', 20],
    ]);
  });

  it('ignores entries that are not numbers and a file without sizes', () => {
    fs.writeFileSync(
      path.join(tmp, 'recover-state.json'),
      JSON.stringify({ sizes: { s1: 'x', s2: 3 } })
    );
    expect([...loadRecoverMarks(config)]).toEqual([['s2', 3]]);
    fs.writeFileSync(path.join(tmp, 'recover-state.json'), '{}');
    expect([...loadRecoverMarks(config)]).toEqual([]);
  });

  it('starts from empty marks when the state file is truncated', () => {
    fs.writeFileSync(path.join(tmp, 'recover-state.json'), '{"sizes":{"x":1');
    expect([...loadRecoverMarks(config)]).toEqual([]);
  });

  it('leaves no temporary file next to the state file after saving', () => {
    saveRecoverMarks(config, new Map([['s1', 1]]));
    expect(fs.readdirSync(tmp)).toEqual(['recover-state.json']);
  });
});

describe('refreshIfGrown outcomes', () => {
  let tmp: string;
  let config: EngramConfig;
  let store: Store;
  let close: () => void;
  let transcript: string;
  const line = (o: object) => JSON.stringify(o) + '\n';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-refresh-unit-'));
    const d = getDefaultConfig();
    config = {
      ...d,
      database: { path: path.join(tmp, 'memory.db') },
      storage: { ...d.storage, jsonlDir: path.join(tmp, 'jsonl') },
    };
    const db = getDatabase(config.database.path);
    initializeSchema(db);
    store = new Store(db);
    close = () => db.close();
    transcript = path.join(tmp, 's1.jsonl');
    fs.writeFileSync(
      transcript,
      line({ type: 'user', message: { role: 'user', content: 'q' } }) +
        line({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
        })
    );
  });
  afterEach(() => {
    close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (marks = new Map<string, number>()) =>
    refreshIfGrown({
      config,
      store,
      sessionId: 's1',
      transcriptPath: transcript,
      marks,
      deletedChunkDigests: new Set(),
    });

  it('returns unchanged without looking further when the size matches the mark', async () => {
    expect(await run(new Map([['s1', fs.statSync(transcript).size]]))).toBe('unchanged');
  });

  it('returns skipped for a session that has no legacy rows', async () => {
    expect(await run()).toBe('skipped');
  });

  function legacySession(chunkCount: number): void {
    store.insertChunks([
      {
        sessionId: 's1',
        projectPath: '/p',
        chunkIndex: 0,
        content: '[User]\nq\n\n[Assistant]\na',
        role: 'mixed',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 1,
      },
    ]);
    store.insertSession({ sessionId: 's1', projectPath: '/p', chunkCount, endedAt: 'old' });
  }

  it('returns unchanged and records the size when the chunk count did not grow', async () => {
    legacySession(1);
    const marks = new Map<string, number>();
    expect(await run(marks)).toBe('unchanged');
    expect(marks.get('s1')).toBe(fs.statSync(transcript).size);
  });

  it('returns skipped when the transcript holds a deleted chunk', async () => {
    legacySession(0);
    const marks = new Map<string, number>();
    const outcome = await refreshIfGrown({
      config,
      store,
      sessionId: 's1',
      transcriptPath: transcript,
      marks,
      deletedChunkDigests: new Set([contentDigest('[User]\nq\n\n[Assistant]\na')]),
    });
    expect(outcome).toBe('skipped');
    expect(marks.get('s1')).toBe(fs.statSync(transcript).size);
  });

  it('refreshes a grown session through a claude receipt and updates the session row', async () => {
    fs.writeFileSync(
      transcript,
      line({
        type: 'user',
        timestamp: '2026-09-01T00:00:00Z',
        message: { role: 'user', content: 'q' },
      }) +
        line({
          type: 'assistant',
          timestamp: '2026-09-01T00:01:00Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
        }) +
        line({
          type: 'user',
          timestamp: '2026-09-01T00:02:00Z',
          message: { role: 'user', content: 'q2' },
        }) +
        line({
          type: 'assistant',
          timestamp: '2026-09-01T00:03:00Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
        })
    );
    legacySession(5);

    expect(await run()).toBe('refreshed');
    expect(fs.readdirSync(path.join(tmp, 'prepared', 'claude'))).toHaveLength(1);
    expect(store.getSession('s1')).toMatchObject({
      endedAt: '2026-09-01T00:03:00Z',
      chunkCount: 2,
    });
  });

  function v2Session(turnKey: string): void {
    store.insertChunks([
      {
        sessionId: 's1',
        projectPath: '/p',
        chunkIndex: 0,
        content: '[User]\nq\n\n[Assistant]\na',
        role: 'mixed',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 1,
      },
    ]);
    const db = getDatabase(config.database.path);
    db.prepare('UPDATE chunks SET turn_key = ? WHERE session_id = ?').run(turnKey, 's1');
    db.close();
    store.insertSession({ sessionId: 's1', projectPath: '/p', chunkCount: 1 });
  }

  it('returns unchanged for a v2 session whose turns are all present', async () => {
    v2Session(createTurnKey('claude', 's1', 'offset:0'));
    const marks = new Map<string, number>();
    expect(await run(marks)).toBe('unchanged');
    expect(marks.get('s1')).toBe(fs.statSync(transcript).size);
  });

  it('returns skipped when one of several turn keys was not derived by recover', async () => {
    const chunk = (content: string, chunkIndex: number) => ({
      sessionId: 's1',
      projectPath: '/p',
      chunkIndex,
      content,
      role: 'human' as const,
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: 1,
    });
    store.insertChunks([chunk('derived', 0), chunk('foreign', 1)]);
    const db = getDatabase(config.database.path);
    db.prepare('UPDATE chunks SET turn_key = ? WHERE content = ?').run(
      createTurnKey('claude', 's1', 'offset:0'),
      'derived'
    );
    db.prepare('UPDATE chunks SET turn_key = ? WHERE content = ?').run('pending-key', 'foreign');
    db.close();
    store.insertSession({ sessionId: 's1', projectPath: '/p', chunkCount: 2 });
    expect(store.getSessionTurnKeys('s1').sort()).toEqual(
      [createTurnKey('claude', 's1', 'offset:0'), 'pending-key'].sort()
    );

    expect(await run()).toBe('skipped');
  });

  it('returns skipped while a pending prompt exists for the session', async () => {
    legacySession(0);
    const dir = path.join(tmp, 'pending', 'claude');
    fs.mkdirSync(dir, { recursive: true });
    writePendingPrompt(tmp, {
      version: 2,
      runtime: 'claude',
      sessionId: 's1',
      projectPath: '/p',
      prompt: 'live',
      source: {},
      pendingKey: 'pk-1',
      turnSequence: 1,
      sourceOrder: '00000000000000000003',
      createdAt: '2026-09-02T00:00:00Z',
    });
    expect(await run()).toBe('skipped');
  });

  it('returns skipped for a v2 session with a turn key it did not derive', async () => {
    v2Session('pending-derived-key');
    const marks = new Map<string, number>();
    expect(await run(marks)).toBe('skipped');
    expect(marks.get('s1')).toBe(fs.statSync(transcript).size);
  });

  it('returns skipped when legacy rows exist but the session row is missing', async () => {
    store.insertChunks([
      {
        sessionId: 's1',
        projectPath: '/p',
        chunkIndex: 0,
        content: 'c',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 1,
      },
    ]);
    expect(await run()).toBe('skipped');
  });
});
