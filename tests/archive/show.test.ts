import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderSession } from '../../src/archive/show';
import { contentDigest } from '../../src/archive/deletions';

const user = (text: string, ts: string) =>
  JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp: ts,
    message: { role: 'user', content: text },
  });
const assistant = (text: string, ts: string) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

describe('renderSession', () => {
  let tmp: string;
  let file: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-show-'));
    file = path.join(tmp, 's1.jsonl');
    fs.writeFileSync(
      file,
      [
        user('first question', '2026-09-01T00:00:00Z'),
        assistant('first answer', '2026-09-01T00:01:00Z'),
        user('second question', '2026-09-02T00:00:00Z'),
        assistant('second answer', '2026-09-02T00:01:00Z'),
      ].join('\n') + '\n'
    );
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const session = () => ({
    sessionId: 's1',
    path: file,
    dirName: '-p',
    cwd: '/w/p',
    gitBranch: 'main',
  });

  it('hides a deleted chunk and keeps the rest', async () => {
    const firstTurn = '[User]\nfirst question\n\n[Assistant]\nfirst answer';
    const out = await renderSession(session(), 0, new Set([contentDigest(firstTurn)]));
    expect(out).toContain('[deleted]');
    expect(out).not.toContain('first answer');
    expect(out).toContain('second answer');
    expect(out).toContain('Turns: 2');
  });

  it('prints a header and every turn when unlimited', async () => {
    const out = await renderSession(session(), 0);
    expect(out).toContain('Session: s1');
    expect(out).toContain('Cwd: /w/p');
    expect(out).toContain('Branch: main');
    expect(out).toContain('Period: 2026-09-01T00:00:00Z .. 2026-09-02T00:01:00Z');
    expect(out).toContain('Turns: 2');
    expect(out).toContain('first answer');
    expect(out).toContain('second answer');
    expect(out).not.toContain('Omitted');
  });

  it('drops the oldest turns first when over maxChars and says how many', async () => {
    const out = await renderSession(session(), 60);
    expect(out).toContain('Omitted 1 earlier turn(s)');
    expect(out).not.toContain('first answer');
    expect(out).toContain('second answer');
  });

  it('keeps the tail of the last turn when even one turn exceeds maxChars', async () => {
    const out = await renderSession(session(), 10);
    expect(out).toContain('Omitted 1 earlier turn(s)');
    expect(out).toContain('d answer');
    expect(out).not.toContain('second question');
  });

  it('reports zero turns for an empty transcript', async () => {
    fs.writeFileSync(file, '');
    expect(await renderSession(session(), 0)).toContain('Turns: 0');
  });

  const SEP = '\n\n---\n\n';
  const t1 = '[User]\nfirst question\n\n[Assistant]\nfirst answer';
  const t2 = '[User]\nsecond question\n\n[Assistant]\nsecond answer';

  it('renders the exact layout', async () => {
    const bare = { sessionId: 's1', path: file };
    expect(await renderSession(bare, 0)).toBe(
      'Session: s1\nCwd: (unknown)\nBranch: (unknown)\n' +
        'Period: 2026-09-01T00:00:00Z .. 2026-09-02T00:01:00Z\nTurns: 2\n\n' +
        `${t1}${SEP}${t2}\n`
    );
  });

  it('keeps every turn when the limit equals the joined length, drops the oldest one char below', async () => {
    const need = t1.length + SEP.length + t2.length;
    expect(await renderSession(session(), need)).toContain(t1);
    const below = await renderSession(session(), need - 1);
    expect(below).not.toContain(t1);
    expect(below).toContain(t2);
  });

  it('keeps a single turn that exactly fits', async () => {
    const out = await renderSession(session(), t2.length);
    expect(out).toContain(t2);
    expect(out).toContain('Omitted 1 earlier turn(s)');
  });

  it('renders placeholders for an empty transcript with a positive limit', async () => {
    fs.writeFileSync(file, '');
    const out = await renderSession({ sessionId: 's1', path: file }, 10);
    expect(out).toBe(
      'Session: s1\nCwd: (unknown)\nBranch: (unknown)\nPeriod: ? .. ?\nTurns: 0\n\n\n'
    );
  });

  it('takes the period from messages that carry a timestamp', async () => {
    const bare = JSON.stringify({
      type: 'user',
      sessionId: 's1',
      message: { role: 'user', content: 'x' },
    });
    fs.writeFileSync(
      file,
      [bare, user('q', '2026-09-03T00:00:00Z'), assistant('a', '2026-09-04T00:00:00Z'), bare].join(
        '\n'
      ) + '\n'
    );
    expect(await renderSession(session(), 0)).toContain(
      'Period: 2026-09-03T00:00:00Z .. 2026-09-04T00:00:00Z'
    );
  });
});
