import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanArchive, formatArchiveHits } from '../../src/search/archive-scan';

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

  it('falls back to the raw line when no message text holds the term', () => {
    put('-a', 'o1', [{ type: 'tool', payload: 'needle-in-tool' }], 100);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)[0].snippet).toContain('needle-in-tool');
  });

  it('reads text blocks from array content and skips non-text blocks', () => {
    put(
      '-a',
      'o1',
      [
        {
          message: {
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
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)[0].snippet).toBe('\n\n\nthe needle here');
  });

  it('survives malformed lines and non-text content', () => {
    fs.mkdirSync(path.join(tmp, '-a'));
    const file = path.join(tmp, '-a', 'bad.jsonl');
    fs.writeFileSync(file, 'not json needle\n{"message":{"content":5}}\n{"message":null}\n');
    const t = new Date(NOW - 100 * DAY);
    fs.utimesSync(file, t, t);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)[0].snippet).toBe('not json needle');
  });

  it('truncates the snippet to 300 characters', () => {
    put('-a', 'o1', [user('needle ' + 'x'.repeat(500))], 100);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)[0].snippet).toHaveLength(300);
  });

  it('returns an empty snippet shape safely and uses the first term for the snippet', () => {
    put('-a', 'o1', [user('alpha line'), user('beta line')], 100);
    expect(scanArchive('beta alpha', tmp, 90 * DAY, NOW)[0].snippet).toBe('beta line');
  });

  it('ignores stray files at the archive root and non-jsonl files', () => {
    const old = new Date(NOW - 100 * DAY);
    fs.writeFileSync(path.join(tmp, 'needle.jsonl'), 'needle');
    fs.utimesSync(path.join(tmp, 'needle.jsonl'), old, old);
    fs.mkdirSync(path.join(tmp, '-a'));
    fs.writeFileSync(path.join(tmp, '-a', 'notes.txt'), 'needle');
    fs.utimesSync(path.join(tmp, '-a', 'notes.txt'), old, old);
    expect(scanArchive('needle', tmp, 0, NOW)).toEqual([]);
  });

  it('requires the whole term, not just its letters', () => {
    put('-a', 'o1', [user('lend me a hand')], 100);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)).toEqual([]);
  });

  it('splits terms on runs of whitespace and ignores surrounding blanks', () => {
    put('-a', 'o1', [user('alpha beta')], 100);
    expect(scanArchive('  alpha \t  beta  ', tmp, 90 * DAY, NOW)).toHaveLength(1);
  });

  it('truncates a raw-line fallback snippet to 300 characters', () => {
    put('-a', 'o1', [{ type: 'tool', payload: 'needle' + 'y'.repeat(500) }], 100);
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)[0].snippet).toHaveLength(300);
  });

  it('ignores lines whose JSON has no message or is null', () => {
    fs.mkdirSync(path.join(tmp, '-a'));
    const file = path.join(tmp, '-a', 'odd.jsonl');
    fs.writeFileSync(file, 'null\n{"x":1}\n{"message":null}\n{"message":{}}\n{"note":"needle"}\n');
    fs.utimesSync(file, new Date(NOW - 100 * DAY), new Date(NOW - 100 * DAY));
    expect(scanArchive('needle', tmp, 90 * DAY, NOW)[0].snippet).toBe('{"note":"needle"}');
  });

  it('ignores a non-string text field inside array content', () => {
    put('-a', 'o1', [{ message: { content: [{ text: 42 }, null] }, n: '42' }], 100);
    expect(scanArchive('42', tmp, 90 * DAY, NOW)[0].snippet).toContain('"text":42');
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
