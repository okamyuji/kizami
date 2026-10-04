import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanArchive, formatArchiveHits } from '../../src/search/archive-scan';
import { contentDigest } from '../../src/archive/deletions';

const DAY = 86400000;
const NOW = Date.parse('2026-10-01T00:00:00Z');

describe('scanArchive', () => {
  let tmp: string;
  function put(dir: string, id: string, lines: object[], ageDays: number) {
    const file = path.join(tmp, dir, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const t = new Date(NOW - ageDays * DAY);
    fs.utimesSync(file, t, t);
  }
  const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
  const asst = (text: string) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

  beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-scan-'))));
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('matches only files older than the cutoff, requiring every term case-insensitively', () => {
    put('-a', 'old1', [user('Retry Policy for staging'), asst('use exponential backoff')], 100);
    put('-a', 'new1', [user('retry policy again')], 10);
    put('-b', 'old2', [user('retry only')], 100);
    const hits = scanArchive('retry POLICY', tmp, 90 * DAY, NOW);
    expect(hits.map((h) => h.sessionId)).toEqual(['old1']);
    expect(hits[0].dirName).toBe('-a');
    expect(hits[0].snippet).toContain('Retry Policy for staging');
  });

  it('does not match a session whose terms appear only in deleted chunks', () => {
    put('-a', 'o1', [user('secret needle'), asst('ok'), user('other'), asst('fine')], 100);
    const deleted = new Set([contentDigest('[User]\nsecret needle\n\n[Assistant]\nok')]);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW, 10, new Set(), deleted)).toEqual([]);
  });

  it('builds the snippet from the kept text only', () => {
    put('-a', 'o1', [user('secret needle'), asst('ok'), user('public needle'), asst('fine')], 100);
    const deleted = new Set([contentDigest('[User]\nsecret needle\n\n[Assistant]\nok')]);
    const hits = scanArchive('needle', tmp, 90 * DAY, NOW, 10, new Set(), deleted);
    expect(hits.map((h) => h.sessionId)).toEqual(['o1']);
    expect(hits[0].snippet).toContain('public needle');
    expect(hits[0].snippet).not.toContain('secret');
  });

  it('requires every term in the kept text', () => {
    put('-a', 'o1', [user('secret needle'), asst('ok'), user('public needle'), asst('fine')], 100);
    const deleted = new Set([contentDigest('[User]\nsecret needle\n\n[Assistant]\nok')]);
    expect(scanArchive('needle secret', tmp, 90 * DAY, NOW, 10, new Set(), deleted)).toEqual([]);
  });

  it('centres a kept-text snippet near the first term and caps its length', () => {
    const pad = 'x'.repeat(600);
    put('-a', 'o1', [user('secret'), asst('ok'), user(`${pad} needle ${pad}`), asst('fine')], 100);
    const deleted = new Set([contentDigest('[User]\nsecret\n\n[Assistant]\nok')]);
    const [hit] = scanArchive('needle', tmp, 90 * DAY, NOW, 10, new Set(), deleted);
    expect(hit.snippet).toContain('needle');
    expect(hit.snippet.length).toBe(300);
    expect(hit.snippet.startsWith('x')).toBe(true);
  });

  it('joins kept turns with a blank line in the snippet', () => {
    put('-a', 'o1', [user('secret'), asst('ok'), user('needle'), asst('fine')], 100);
    const deleted = new Set([contentDigest('[User]\nsecret\n\n[Assistant]\nok')]);
    const [hit] = scanArchive('needle', tmp, 90 * DAY, NOW, 10, new Set(), deleted);
    expect(hit.snippet).toBe('[deleted]\n\n[User]\nneedle\n\n[Assistant]\nfine');
  });

  it('skips deleted sessions', () => {
    put('-a', 'gone', [user('needle')], 100);
    put('-a', 'kept', [user('needle')], 120);
    expect(
      scanArchive('needle', tmp, 90 * DAY, NOW, 10, new Set(['gone'])).map((h) => h.sessionId)
    ).toEqual(['kept']);
  });

  it('orders by mtime descending and caps at limit', () => {
    put('-a', 'o1', [user('needle')], 200);
    put('-a', 'o2', [user('needle')], 100);
    put('-a', 'o3', [user('needle')], 150);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW, 2).map((h) => h.sessionId)).toEqual([
      'o2',
      'o3',
    ]);
  });

  it('uses 10 as the default limit', () => {
    for (let i = 0; i < 12; i++) put('-a', `s${i}`, [user('needle')], 100 + i);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)).toHaveLength(10);
  });

  it('returns an empty list for a missing archive dir or a blank query', () => {
    expect(scanArchive('x', path.join(tmp, 'none'), 0, NOW)).toEqual([]);
    put('-a', 'o1', [user('needle')], 100);
    expect(scanArchive('   ', tmp, 0, NOW)).toEqual([]);
  });

  it('treats a file exactly at the cutoff age as not old enough', () => {
    put('-a', 'edge', [user('needle')], 90);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)).toEqual([]);
    expect(scanArchive('needle', tmp, 90 * DAY - 1, NOW).map((h) => h.sessionId)).toEqual(['edge']);
  });

  it('does not match a term found only outside the conversation text', () => {
    put('-a', 'o1', [{ type: 'tool', payload: 'needle-in-tool' }, user('hello')], 100);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)).toEqual([]);
  });

  it('reads text blocks from array content and skips non-text blocks', () => {
    put(
      '-a',
      'o1',
      [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              null,
              'str',
              { type: 'tool_use', name: 'x' },
              { type: 'text', text: 'the needle here' },
            ],
          },
        },
      ],
      100
    );
    const { snippet } = scanArchive('needle', tmp, 90 * DAY, NOW)[0];
    expect(snippet).toContain('the needle here');
    expect(snippet).not.toContain('{');
  });

  it('survives malformed lines and non-text content', () => {
    fs.mkdirSync(path.join(tmp, '-a'));
    const file = path.join(tmp, '-a', 'bad.jsonl');
    fs.writeFileSync(file, 'not json needle\n{"message":{"content":5}}\n{"message":null}\n');
    const t = new Date(NOW - 100 * DAY);
    fs.utimesSync(file, t, t);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)).toEqual([]);
  });

  it('truncates the snippet to 300 characters', () => {
    put('-a', 'o1', [user('needle ' + 'x'.repeat(500))], 100);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)[0].snippet).toHaveLength(300);
  });

  it('returns an empty snippet shape safely and uses the first term for the snippet', () => {
    put('-a', 'o1', [user('alpha line'), user('beta line')], 100);
    expect(scanArchive('beta alpha', tmp, 90 * DAY, NOW)[0].snippet).toBe(
      '[User]\nalpha line\n\n[User]\nbeta line'
    );
  });

  it('ignores stray files at the archive root and non-jsonl files', () => {
    const old = new Date(NOW - 100 * DAY);
    const line = JSON.stringify(user('needle'));
    fs.writeFileSync(path.join(tmp, 'needle.jsonl'), line);
    fs.utimesSync(path.join(tmp, 'needle.jsonl'), old, old);
    fs.mkdirSync(path.join(tmp, '-a'));
    fs.writeFileSync(path.join(tmp, '-a', 'notes.txt'), line);
    fs.utimesSync(path.join(tmp, '-a', 'notes.txt'), old, old);
    expect(scanArchive('needle', tmp, 0, NOW)).toEqual([]);
  });

  it('skips an entry it cannot stat and keeps scanning', () => {
    fs.mkdirSync(path.join(tmp, '-a'));
    fs.symlinkSync(path.join(tmp, 'missing'), path.join(tmp, '-a', 'dangling.jsonl'));
    put('-b', 'o1', [user('needle here')], 100);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW).map((h) => h.sessionId)).toEqual(['o1']);
  });

  // root は chmod 000 でも読めるので、この失敗を起こせない。
  it.skipIf(process.getuid?.() === 0)('skips a directory it cannot read', () => {
    put('-locked', 'o2', [user('needle there')], 100);
    put('-b', 'o1', [user('needle here')], 100);
    fs.chmodSync(path.join(tmp, '-locked'), 0o000);
    try {
      expect(scanArchive('needle', tmp, 90 * DAY, NOW).map((h) => h.sessionId)).toEqual(['o1']);
    } finally {
      fs.chmodSync(path.join(tmp, '-locked'), 0o700);
    }
  });

  it('requires the whole term, not just its letters', () => {
    put('-a', 'o1', [user('lend me a hand')], 100);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)).toEqual([]);
  });

  it('splits terms on runs of whitespace and ignores surrounding blanks', () => {
    put('-a', 'o1', [user('alpha beta')], 100);
    expect(scanArchive('  alpha \t  beta  ', tmp, 90 * DAY, NOW)).toHaveLength(1);
  });

  it('ignores lines whose JSON has no message or is null', () => {
    fs.mkdirSync(path.join(tmp, '-a'));
    const file = path.join(tmp, '-a', 'odd.jsonl');
    fs.writeFileSync(file, 'null\n{"x":1}\n{"message":null}\n{"message":{}}\n{"note":"needle"}\n');
    fs.utimesSync(file, new Date(NOW - 100 * DAY), new Date(NOW - 100 * DAY));
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)).toEqual([]);
  });

  it('ignores a non-string text field inside array content', () => {
    put('-a', 'o1', [{ message: { content: [{ text: 42 }, null] }, n: '42' }], 100);
    expect(scanArchive('42', tmp, 90 * DAY, NOW)).toEqual([]);
  });

  it('formats hits with date, short id and project dir', () => {
    const out = formatArchiveHits([
      {
        sessionId: 'abcdef123',
        dirName: '-Users-me-proj',
        mtime: new Date('2026-06-01T00:00:00Z'),
        snippet: 'hello',
      },
    ]);
    expect(out).toBe('[2026-06-01 abcdef from=-Users-me-proj archived]\nhello\n');
  });

  it('separates multiple hits with ---', () => {
    const h = (id: string) => ({
      sessionId: id,
      dirName: 'd',
      mtime: new Date('2026-06-01T00:00:00Z'),
      snippet: 's',
    });
    expect(formatArchiveHits([h('aaaaaa'), h('bbbbbb')])).toBe(
      '[2026-06-01 aaaaaa from=d archived]\ns\n---\n[2026-06-01 bbbbbb from=d archived]\ns\n'
    );
  });
});
