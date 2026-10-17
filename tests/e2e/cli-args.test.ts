import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-e2e-args-'));
  dirs.push(root);
  const result = spawnSync(process.execPath, ['dist/cli.js', ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: root,
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      KIZAMI_JSONL_DIR: path.join(root, 'jsonl'),
      KIZAMI_TRANSCRIPT_ARCHIVE_DIR: path.join(root, 'transcripts'),
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, root };
}

describe('built CLI argument handling', () => {
  it('prints usage for setup --help without writing any settings', () => {
    const result = runCli(['setup', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kizami <command> [options]');
    expect(fs.readdirSync(result.root)).toEqual([]);
  });

  it('prints usage for the -h short flag', () => {
    const result = runCli(['-h']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kizami <command> [options]');
  });

  it('rejects a misspelled setup option instead of running a full setup', () => {
    const result = runCli(['setup', '--recal-only']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("'--recal-only'");
    expect(result.stdout).toBe('');
    expect(fs.readdirSync(result.root)).toEqual([]);
  });

  it('rejects a string option given without its value', () => {
    const result = runCli(['search', 'retry', '--project']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("'--project");
    expect(fs.readdirSync(result.root)).toEqual([]);
  });

  it('still prints the version for --version', () => {
    const result = runCli(['--version']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('passes options after -- to resume without treating them as kizami options', () => {
    const result = runCli(['resume', 'zzzz', '--', '-p', 'continue']);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('Unknown option');
    expect(result.stderr).toContain('zzzz');
  });
});
