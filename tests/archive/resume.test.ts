import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { spawnSync } from 'node:child_process';
import { resumeSession } from '../../src/archive/resume';
import { SessionLookupError } from '../../src/archive/resolve';

describe('resumeSession', () => {
  let tmp: string;
  let projectsDir: string;
  let archived: string;
  let cwd: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-resume-'));
    projectsDir = path.join(tmp, 'projects');
    cwd = path.join(tmp, 'work');
    fs.mkdirSync(cwd);
    archived = path.join(tmp, 'archive', '-w', 'abcd0001.jsonl');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.writeFileSync(archived, '{"cwd":"x"}\n');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const session = (over = {}) => ({
    sessionId: 'abcd0001',
    path: archived,
    dirName: '-w',
    cwd,
    ...over,
  });
  const fakeSpawn = (status: number | null, error?: Error) =>
    vi.fn(() => ({ status, error })) as unknown as typeof spawnSync;

  it('runs claude -r in the session cwd with passthrough args and returns its exit code', () => {
    const spawn = fakeSpawn(3);
    expect(resumeSession(session(), ['-p', 'ok'], { projectsDir, spawn })).toBe(3);
    expect(spawn).toHaveBeenCalledWith('claude', ['-r', 'abcd0001', '-p', 'ok'], {
      cwd,
      stdio: 'inherit',
    });
  });

  it('returns 0 when claude exits 0', () => {
    expect(resumeSession(session(), [], { projectsDir, spawn: fakeSpawn(0) })).toBe(0);
  });

  it('restores the transcript into the projects dir when Claude Code already deleted it', () => {
    resumeSession(session(), [], { projectsDir, spawn: fakeSpawn(0) });
    expect(fs.readFileSync(path.join(projectsDir, '-w', 'abcd0001.jsonl'), 'utf-8')).toBe(
      '{"cwd":"x"}\n'
    );
  });

  it('restores the transcript with owner-only permissions', () => {
    fs.chmodSync(session().path, 0o644);
    resumeSession(session(), [], { projectsDir, spawn: fakeSpawn(0) });
    const live = path.join(projectsDir, session().dirName, `${session().sessionId}.jsonl`);
    expect(fs.statSync(live).mode & 0o777).toBe(0o600);
  });

  it('restores the transcript before claude starts', () => {
    const live = path.join(projectsDir, '-w', 'abcd0001.jsonl');
    const spawn = vi.fn(() => ({
      status: fs.existsSync(live) ? 0 : 9,
    })) as unknown as typeof spawnSync;
    expect(resumeSession(session(), [], { projectsDir, spawn })).toBe(0);
  });

  it('does not overwrite a live transcript', () => {
    const live = path.join(projectsDir, '-w', 'abcd0001.jsonl');
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(live, 'live\n');
    resumeSession(session(), [], { projectsDir, spawn: fakeSpawn(0) });
    expect(fs.readFileSync(live, 'utf-8')).toBe('live\n');
  });

  it('fails with a show hint when the working directory is gone', () => {
    const spawn = fakeSpawn(0);
    expect(() =>
      resumeSession(session({ cwd: path.join(tmp, 'gone') }), [], { projectsDir, spawn })
    ).toThrow(/kizami show abcd0001/);
    expect(() => resumeSession(session({ cwd: undefined }), [], { projectsDir, spawn })).toThrow(
      SessionLookupError
    );
    expect(() => resumeSession(session({ cwd: undefined }), [], { projectsDir, spawn })).toThrow(
      /\(unknown\)/
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(projectsDir)).toBe(false);
  });

  it('surfaces a spawn error', () => {
    expect(() =>
      resumeSession(session(), [], {
        projectsDir,
        spawn: fakeSpawn(null, new Error('ENOENT claude')),
      })
    ).toThrow(/ENOENT claude/);
  });

  it('returns 1 when claude was killed by a signal', () => {
    expect(resumeSession(session(), [], { projectsDir, spawn: fakeSpawn(null) })).toBe(1);
  });
});
