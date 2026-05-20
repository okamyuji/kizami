import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getHostnameSegment,
  getMonthSegment,
  getJsonlFilename,
  getJsonlFilePath,
  ensureJsonlDir,
  listJsonlFiles,
} from '@/jsonl/path';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-jsonl-path-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('jsonl/path', () => {
  it('sanitizes hostname segment', () => {
    const seg = getHostnameSegment();
    expect(seg).toMatch(/^[a-z0-9_-]+$/);
    expect(seg.length).toBeGreaterThan(0);
  });

  it('formats month segment with UTC zero padding', () => {
    expect(getMonthSegment(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01');
    expect(getMonthSegment(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12');
  });

  it('composes filename as YYYY-MM-host.jsonl', () => {
    const fn = getJsonlFilename(new Date(Date.UTC(2026, 4, 21)), 'testhost');
    expect(fn).toBe('2026-05-testhost.jsonl');
  });

  it('returns absolute path within given dir', () => {
    const tmp = makeTmpDir();
    const p = getJsonlFilePath(tmp, new Date(Date.UTC(2026, 4, 21)));
    expect(p.startsWith(tmp)).toBe(true);
    expect(p.endsWith('.jsonl')).toBe(true);
  });

  it('ensureJsonlDir creates directory recursively', () => {
    const tmp = makeTmpDir();
    const nested = path.join(tmp, 'a', 'b', 'c');
    ensureJsonlDir(nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('listJsonlFiles returns sorted .jsonl files only', () => {
    const tmp = makeTmpDir();
    fs.writeFileSync(path.join(tmp, '2026-02-h.jsonl'), '');
    fs.writeFileSync(path.join(tmp, '2026-01-h.jsonl'), '');
    fs.writeFileSync(path.join(tmp, 'not-jsonl.txt'), '');
    fs.writeFileSync(path.join(tmp, '2026-03-h.jsonl'), '');
    const files = listJsonlFiles(tmp).map((f) => path.basename(f));
    expect(files).toEqual(['2026-01-h.jsonl', '2026-02-h.jsonl', '2026-03-h.jsonl']);
  });

  it('listJsonlFiles returns [] when dir does not exist', () => {
    expect(listJsonlFiles('/nonexistent/path/should/not/be/here')).toEqual([]);
  });
});
