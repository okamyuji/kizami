import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compactSessions } from '@/jsonl/compact';
import { foldCanonicalHistory } from '@/jsonl/fold';
import { JsonlTransactionWriter, JsonlWriter } from '@/jsonl/writer';
import { serializeV2Transaction } from '@/jsonl/transaction';
import { listJsonlFiles, getJsonlFilePath } from '@/jsonl/path';
import type { JsonlV2Payload } from '@/jsonl/types';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-compact-'));
  dirs.push(dir);
  return dir;
}

const NOW = new Date('2026-10-17T00:00:00Z');

function checkpoint(
  sessionId: string,
  turnKey: string,
  historyEpoch: number,
  revision: number,
  parts: Array<[externalId: string, content: string]>
): JsonlV2Payload {
  return {
    v: 2,
    type: 'turn_checkpoint',
    txId: '',
    sessionId,
    runtime: 'claude',
    turnKey,
    sourceOrder: '00000000000000000001',
    observedThrough: { kind: 'source_offset', generation: 0, offset: 1 },
    historyEpoch,
    revision,
    contentHash: `h-${turnKey}-${historyEpoch}-${revision}`,
    completedAt: '2026-10-17T00:00:00Z',
    projectPath: '/p',
    parts: parts.map(([externalId, content], partIndex) => ({
      partIndex,
      externalId,
      content,
      role: 'mixed' as const,
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: 1,
    })),
  };
}

const reset = (sessionId: string, historyEpoch: number): JsonlV2Payload => ({
  v: 2,
  type: 'session_reset',
  txId: '',
  sessionId,
  historyEpoch,
  reason: 'legacy_mismatch',
});
const chunkDelete = (sessionId: string, externalId: string): JsonlV2Payload => ({
  v: 2,
  type: 'chunk_delete',
  txId: '',
  sessionId,
  externalId,
});

function append(dir: string, txId: string, payloads: JsonlV2Payload[]): void {
  const writer = new JsonlTransactionWriter(dir);
  try {
    writer.withExclusiveTransaction((w) => {
      const serialized = serializeV2Transaction(payloads, {
        txId,
        createdAt: NOW.toISOString(),
        targetPath: getJsonlFilePath(dir, NOW),
      });
      w.applyCommittedToIndex(w.appendPrepared(serialized).transaction);
    });
  } finally {
    writer.close();
  }
}

function legacy(dir: string, sessionId: string, id: string, content: string): void {
  new JsonlWriter(dir).appendRecords(
    [
      {
        v: 1,
        type: 'chunk',
        id,
        sessionId,
        projectPath: '/p',
        chunkIndex: 0,
        content,
        role: 'mixed',
        metadata: null,
        tokenCount: 1,
        createdAt: NOW.toISOString(),
      },
    ],
    NOW
  );
}

const text = (dir: string) =>
  listJsonlFiles(dir)
    .map((f) => fs.readFileSync(f, 'utf-8'))
    .join('');
const folded = async (dir: string) => {
  const h = await foldCanonicalHistory(listJsonlFiles(dir));
  return {
    turns: [...h.turns.entries()].sort(),
    legacy: h.legacyChunks,
    resets: [...h.resetSessions].sort(),
    errors: h.errors,
  };
};

// 対象セッション S に、fold が捨てる本文をすべての形で置く。O は対象外のセッション。
function seed(dir: string): void {
  legacy(dir, 'S', 'L1', 'legacy-secret');
  legacy(dir, 'O', 'L2', 'other-legacy');
  append(dir, 'tx1', [checkpoint('S', 't1', 0, 1, [['p1', 'old-epoch-secret']])]);
  append(dir, 'tx2', [
    reset('S', 1),
    checkpoint('S', 't1', 1, 1, [
      ['q1', 'kept'],
      ['q2', 'old-revision-secret'],
    ]),
  ]);
  append(dir, 'tx2b', [checkpoint('S', 't2', 1, 1, [['r1', 'kept-other-turn']])]);
  append(dir, 'tx3', [
    checkpoint('S', 't1', 1, 2, [
      ['q1', 'kept'],
      ['q3', 'deleted-secret'],
    ]),
  ]);
  legacy(dir, 'S', 'L4', 'late-legacy-secret');
  append(dir, 'tx4', [chunkDelete('S', 'q3')]);
  append(dir, 'tx4b', [checkpoint('S', 't3', 1, 1, [['d1', 'whole-turn-deleted-secret']])]);
  append(dir, 'tx4c', [chunkDelete('S', 'd1')]);
  append(dir, 'tx5', [checkpoint('O', 't1', 0, 1, [['o1', 'other']])]);
  append(dir, 'tx6', [
    checkpoint('S', 't4', 1, 1, [['e1', 'kept-beside']]),
    checkpoint('S', 't5', 1, 1, [
      ['e2', 'kept-part'],
      ['e3', 'partial-deleted-secret'],
    ]),
  ]);
  append(dir, 'tx7', [chunkDelete('S', 'e3')]);
  legacy(dir, 'O', 'L5', 'other-deleted-legacy');
  append(dir, 'tx8', [chunkDelete('O', 'L5')]);
}

describe('compactSessions', () => {
  it('removes the old epoch, the old revision, deleted parts and reset legacy rows of a target session', async () => {
    const dir = makeDir();
    seed(dir);
    const before = await folded(dir);

    expect(await compactSessions(dir, new Set(['S']))).toBe('compacted');

    for (const secret of [
      'legacy-secret',
      'old-epoch-secret',
      'old-revision-secret',
      'deleted-secret',
      'late-legacy-secret',
      'whole-turn-deleted-secret',
      'partial-deleted-secret',
    ]) {
      expect(text(dir)).not.toContain(secret);
    }
    expect(text(dir)).toContain('kept-other-turn');
    expect(text(dir)).toContain('kept-beside');
    expect(text(dir)).toContain('kept-part');
    expect(text(dir)).not.toContain('"txId":"tx1"');
    expect(text(dir)).not.toContain('"txId":"tx4b"');
    expect(text(dir)).not.toContain('\n\n');
    expect(await folded(dir)).toEqual(before);
    expect(before.errors).toEqual([]);
  });

  it('keeps the lines of other sessions byte for byte and the file owner-only', async () => {
    const dir = makeDir();
    seed(dir);
    const otherLines = text(dir)
      .split('\n')
      .filter((l) => l.includes('"O"'));

    await compactSessions(dir, new Set(['S']));

    const after = text(dir).split('\n');
    for (const line of otherLines) expect(after).toContain(line);
    expect(fs.statSync(listJsonlFiles(dir)[0]).mode & 0o777).toBe(0o600);
  });

  it('returns unchanged and leaves the file alone when nothing is left to drop', async () => {
    const dir = makeDir();
    seed(dir);
    await compactSessions(dir, new Set(['S', 'O']));
    const file = listJsonlFiles(dir)[0];
    const { ino } = fs.statSync(file);

    expect(await compactSessions(dir, new Set(['S']))).toBe('unchanged');
    expect(await compactSessions(dir, new Set(['O']))).toBe('unchanged');
    expect(fs.statSync(file).ino).toBe(ino);
  });

  it('leaves a frame alone when another line sits inside it', async () => {
    const dir = makeDir();
    seed(dir);
    const file = listJsonlFiles(dir)[0];
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    const begin = lines.findIndex((l) => l.includes('"tx_begin"') && l.includes('"tx1"'));
    const stray = JSON.stringify({
      v: 1,
      type: 'chunk',
      id: 'L3',
      sessionId: 'O',
      projectPath: '/p',
      chunkIndex: 0,
      content: 'stray-inside-frame',
      role: 'mixed',
      metadata: null,
      tokenCount: 1,
      createdAt: NOW.toISOString(),
    });
    lines.splice(begin + 1, 0, stray);
    fs.writeFileSync(file, lines.join('\n'));
    const before = await folded(dir);

    await compactSessions(dir, new Set(['S']));

    expect(text(dir)).toContain('stray-inside-frame');
    expect(text(dir)).toContain('old-epoch-secret');
    expect(await folded(dir)).toEqual(before);
  });

  it('refuses to touch a store that fold reports as broken and names every reason', async () => {
    const dir = makeDir();
    seed(dir);
    const file = listJsonlFiles(dir)[0];
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf-8').replaceAll('"payloadDigest":"', '"payloadDigest":"x')
    );

    await expect(compactSessions(dir, new Set(['S']))).rejects.toThrow(
      'invalid transaction frame; invalid transaction frame'
    );
    expect(text(dir)).toContain('old-epoch-secret');
  });

  it('compacts a store whose last frame was left unfinished, keeping that tail', async () => {
    const dir = makeDir();
    seed(dir);
    const file = listJsonlFiles(dir)[0];
    const tail = JSON.stringify({
      v: 2,
      type: 'tx_begin',
      txId: 'torn',
      createdAt: NOW.toISOString(),
    });
    fs.appendFileSync(file, tail + '\n');

    expect(await compactSessions(dir, new Set(['S']))).toBe('compacted');
    expect(text(dir)).not.toContain('old-epoch-secret');
    expect(text(dir).endsWith(tail + '\n')).toBe(true);
  });
});
