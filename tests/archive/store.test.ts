import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { archiveTranscript, archiveAll, getClaudeProjectsDir } from '../../src/archive/store';

describe('archiveTranscript', () => {
  let tmp: string;
  let projects: string;
  let archive: string;
  let src: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-archive-'));
    projects = path.join(tmp, 'projects');
    archive = path.join(tmp, 'archive');
    fs.mkdirSync(path.join(projects, '-Users-me-proj'), { recursive: true });
    src = path.join(projects, '-Users-me-proj', 'aaaa1111-0000-0000-0000-000000000000.jsonl');
    fs.writeFileSync(src, '{"type":"user"}\n');
    fs.utimesSync(src, new Date('2026-01-01'), new Date('2026-01-01'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const dest = () =>
    path.join(archive, '-Users-me-proj', 'aaaa1111-0000-0000-0000-000000000000.jsonl');

  it('copies into the mirrored project directory and keeps the source mtime', () => {
    expect(archiveTranscript(src, archive)).toBe('copied');
    expect(fs.readFileSync(dest(), 'utf-8')).toBe('{"type":"user"}\n');
    expect(fs.statSync(dest()).mtimeMs).toBe(fs.statSync(src).mtimeMs);
  });

  it('returns current when the archived copy is not older than the source', () => {
    archiveTranscript(src, archive);
    expect(archiveTranscript(src, archive)).toBe('current');
  });

  it('recopies when the source changed after archiving', () => {
    archiveTranscript(src, archive);
    fs.appendFileSync(src, '{"type":"assistant"}\n');
    fs.utimesSync(src, new Date('2026-02-01'), new Date('2026-02-01'));
    expect(archiveTranscript(src, archive)).toBe('copied');
    expect(fs.readFileSync(dest(), 'utf-8')).toContain('assistant');
  });

  it('skips a missing file and a non-jsonl file', () => {
    expect(archiveTranscript(path.join(projects, 'nope.jsonl'), archive)).toBe('skipped');
    const txt = path.join(projects, '-Users-me-proj', 'note.txt');
    fs.writeFileSync(txt, 'x');
    expect(archiveTranscript(txt, archive)).toBe('skipped');
  });

  it('leaves no temp file behind', () => {
    archiveTranscript(src, archive);
    expect(fs.readdirSync(path.dirname(dest()))).toEqual([path.basename(dest())]);
  });
});

describe('archiveAll', () => {
  let tmp: string;
  beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-archive-all-'))));
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('archives top-level session files and ignores subagent directories', () => {
    const projects = path.join(tmp, 'projects');
    const dir = path.join(projects, '-p');
    fs.mkdirSync(path.join(dir, 'bbbb2222', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bbbb2222.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'bbbb2222', 'subagents', 'agent-1.jsonl'), '{}\n');
    const archive = path.join(tmp, 'archive');

    expect(archiveAll(projects, archive)).toEqual({ copied: 1, current: 0, failed: 0 });
    expect(archiveAll(projects, archive)).toEqual({ copied: 0, current: 1, failed: 0 });
    expect(fs.existsSync(path.join(archive, '-p', 'bbbb2222', 'subagents'))).toBe(false);
  });

  it('returns zero counts when the projects directory does not exist', () => {
    expect(archiveAll(path.join(tmp, 'missing'), path.join(tmp, 'a'))).toEqual({
      copied: 0,
      current: 0,
      failed: 0,
    });
  });
});

describe('getClaudeProjectsDir', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  });

  it('honors CLAUDE_CONFIG_DIR', () => {
    process.env.CLAUDE_CONFIG_DIR = '/x/cfg';
    expect(getClaudeProjectsDir()).toBe(path.join('/x/cfg', 'projects'));
  });

  it('defaults to ~/.claude/projects', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(getClaudeProjectsDir()).toBe(path.join(os.homedir(), '.claude', 'projects'));
  });
});
