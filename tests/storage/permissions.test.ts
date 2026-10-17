import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  enforcePrivateDirectory,
  enforcePrivateFile,
  readPrivateTextFile,
  restrictSqliteFile,
} from '@/storage/permissions';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('private storage permissions', () => {
  it('creates a private directory and corrects a regular file mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-mode-'));
    dirs.push(root);
    const directory = path.join(root, 'state');
    enforcePrivateDirectory(directory);
    const file = path.join(directory, 'record.json');
    fs.writeFileSync(file, '{}', { mode: 0o666 });
    fs.chmodSync(file, 0o666);

    enforcePrivateFile(file);

    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('corrects an existing dedicated storage directory mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-mode-'));
    dirs.push(root);
    const directory = path.join(root, 'shared');
    fs.mkdirSync(directory, { mode: 0o755 });
    fs.chmodSync(directory, 0o755);

    enforcePrivateDirectory(directory);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('restricts a SQLite file by its path, does nothing for a missing one, and rejects a link or a directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-mode-'));
    dirs.push(root);
    const file = path.join(root, 'memory.db');
    fs.writeFileSync(file, 'db', { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    restrictSqliteFile(file);

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => restrictSqliteFile(path.join(root, 'missing.db-wal'))).not.toThrow();
    const target = path.join(root, 'target.db');
    fs.writeFileSync(target, 'other', { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    fs.symlinkSync(target, path.join(root, 'link.db'));
    expect(() => restrictSqliteFile(path.join(root, 'link.db'))).toThrow(/symlink/);
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    fs.mkdirSync(path.join(root, 'dir.db'));
    expect(() => restrictSqliteFile(path.join(root, 'dir.db'))).toThrow(/not a file/);
  });

  it('does nothing for a missing file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-mode-'));
    dirs.push(root);

    expect(() => enforcePrivateFile(path.join(root, 'missing.json'))).not.toThrow();
  });

  it('tightens a read file through its opened descriptor', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-mode-'));
    dirs.push(root);
    const file = path.join(root, 'receipt.json');
    fs.writeFileSync(file, '{"phase":"prepared"}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    expect(readPrivateTextFile(file, 1024)).toBe('{"phase":"prepared"}');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rejects directory and file symlinks without changing their targets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-mode-'));
    dirs.push(root);
    const targetDirectory = path.join(root, 'target');
    fs.mkdirSync(targetDirectory, { mode: 0o755 });
    fs.chmodSync(targetDirectory, 0o755);
    const directoryLink = path.join(root, 'directory-link');
    fs.symlinkSync(targetDirectory, directoryLink);

    expect(() => enforcePrivateDirectory(directoryLink)).toThrow(/symlink/);
    expect(fs.statSync(targetDirectory).mode & 0o777).toBe(0o755);

    const targetFile = path.join(root, 'target.txt');
    fs.writeFileSync(targetFile, 'private', { mode: 0o644 });
    fs.chmodSync(targetFile, 0o644);
    const fileLink = path.join(root, 'file-link');
    fs.symlinkSync(targetFile, fileLink);

    expect(() => enforcePrivateFile(fileLink)).toThrow(/symlink/);
    expect(fs.statSync(targetFile).mode & 0o777).toBe(0o644);
  });
});
