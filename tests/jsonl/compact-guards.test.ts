import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CanonicalHistory } from '@/jsonl/fold';

// 2回目の fold（書き換え後の確認）の直前に、テストごとの処理を挟む
const between = vi.hoisted(() => ({
  run: undefined as undefined | ((h: unknown, files: string[]) => unknown),
}));
vi.mock('@/jsonl/fold', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/jsonl/fold')>();
  let calls = 0;
  return {
    ...real,
    foldCanonicalHistory: async (files: string[]) => {
      const history = await real.foldCanonicalHistory(files);
      calls += 1;
      return calls % 2 === 0 && between.run ? between.run(history, files) : history;
    },
  };
});

const { compactSessions } = await import('@/jsonl/compact');
const { JsonlTransactionWriter } = await import('@/jsonl/writer');
const { serializeV2Transaction } = await import('@/jsonl/transaction');
const { getJsonlFilePath, listJsonlFiles } = await import('@/jsonl/path');

const dirs: string[] = [];
afterEach(() => {
  between.run = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function seed(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-compact-guard-'));
  dirs.push(dir);
  const now = new Date('2026-10-17T00:00:00Z');
  const part = (content: string) => ({
    partIndex: 0,
    externalId: content,
    content,
    role: 'mixed' as const,
    metadata: { filePaths: [], toolNames: [], errorMessages: [] },
    tokenCount: 1,
  });
  const checkpoint = (historyEpoch: number, content: string) => ({
    v: 2 as const,
    type: 'turn_checkpoint' as const,
    txId: '',
    sessionId: 'S',
    runtime: 'claude' as const,
    turnKey: 't',
    sourceOrder: '1',
    observedThrough: { kind: 'source_offset' as const, generation: 0, offset: 1 },
    historyEpoch,
    revision: 1,
    contentHash: content,
    completedAt: now.toISOString(),
    projectPath: '/p',
    parts: [part(content)],
  });
  const writer = new JsonlTransactionWriter(dir);
  try {
    const frames = [
      [checkpoint(0, 'old-secret')],
      [
        {
          v: 2 as const,
          type: 'session_reset' as const,
          txId: '',
          sessionId: 'S',
          historyEpoch: 1,
          reason: 'legacy_mismatch' as const,
        },
        checkpoint(1, 'kept'),
      ],
    ];
    frames.forEach((payloads, i) =>
      writer.withExclusiveTransaction((w) => {
        const tx = serializeV2Transaction(payloads, {
          txId: `tx${i}`,
          createdAt: now.toISOString(),
          targetPath: getJsonlFilePath(dir, now),
        });
        w.applyCommittedToIndex(w.appendPrepared(tx).transaction);
      })
    );
  } finally {
    writer.close();
  }
  return dir;
}

const text = (dir: string) => fs.readFileSync(listJsonlFiles(dir)[0], 'utf-8');

describe('compactSessions guards', () => {
  it('returns retry and changes nothing when the file grows before the swap', async () => {
    const dir = seed();
    let checked: string[] = [];
    between.run = (history, files) => {
      checked = files;
      fs.appendFileSync(listJsonlFiles(dir)[0], '\n');
      return history;
    };

    expect(await compactSessions(dir, new Set(['S']))).toBe('retry');
    expect(checked.map((f) => f.endsWith('.tmp'))).toEqual([true]);
    expect(text(dir)).toContain('old-secret');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.compact-'))).toEqual([]);
  });

  it('refuses to swap when the rewritten store would fold differently', async () => {
    const dir = seed();
    between.run = (history) => ({ ...(history as CanonicalHistory), turns: new Map() });

    await expect(compactSessions(dir, new Set(['S']))).rejects.toThrow(/change the folded history/);
    expect(text(dir)).toContain('old-secret');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.compact-'))).toEqual([]);
  });

  it('returns retry when the file was replaced by another of the same size before the swap', async () => {
    const dir = seed();
    between.run = (history) => {
      const file = listJsonlFiles(dir)[0];
      fs.copyFileSync(file, `${file}.copy`);
      fs.renameSync(`${file}.copy`, file);
      return history;
    };

    expect(await compactSessions(dir, new Set(['S']))).toBe('retry');
    expect(text(dir)).toContain('old-secret');
  });
});
