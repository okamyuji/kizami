import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

// chmod の失敗を作るため、fs を差し替える
const chmod = vi.hoisted(() => ({
  error: undefined as NodeJS.ErrnoException | undefined,
  calls: 0,
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const chmodSync: typeof real.chmodSync = (...args) => {
    chmod.calls += 1;
    if (chmod.error) throw chmod.error;
    return real.chmodSync(...args);
  };
  return { ...real, default: { ...real, chmodSync }, chmodSync };
});

const fs = await import('node:fs');
const { restrictSqliteFile } = await import('@/storage/permissions');

const failure = (code: string) => Object.assign(new Error(code), { code });

describe('restrictSqliteFile when chmod fails', () => {
  const dirs: string[] = [];
  const makeFile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-chmod-'));
    dirs.push(dir);
    const file = path.join(dir, 'memory.db-shm');
    fs.writeFileSync(file, '');
    return file;
  };
  afterEach(() => {
    chmod.error = undefined;
    chmod.calls = 0;
    vi.unstubAllGlobals();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes over a file another process removed after the check', () => {
    chmod.error = failure('ENOENT');

    expect(() => restrictSqliteFile(makeFile())).not.toThrow();
  });

  it('throws any other failure', () => {
    chmod.error = failure('EACCES');

    expect(() => restrictSqliteFile(makeFile())).toThrow('EACCES');
  });

  it('does not change the mode on Windows', () => {
    const file = makeFile();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      restrictSqliteFile(file);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }

    expect(chmod.calls).toBe(0);
  });
});
