import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadDeletions,
  recordSessionDeletion,
  recordChunkDeletion,
  contentDigest,
  redactTurnText,
} from '../../src/archive/deletions';
import { splitTurnText } from '../../src/parser/chunker';

describe('deletions', () => {
  let tmp: string;
  let file: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-deletions-'));
    file = path.join(tmp, 'state', 'deletions.json');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns an empty record when the file does not exist', () => {
    const d = loadDeletions(file);
    expect([...d.sessions]).toEqual([]);
    expect([...d.chunkDigests]).toEqual([]);
  });

  it('records deleted sessions once each and creates the parent directory', () => {
    recordSessionDeletion(file, 'aaaa0001');
    recordSessionDeletion(file, 'aaaa0001');
    recordSessionDeletion(file, 'bbbb0002');
    expect([...loadDeletions(file).sessions]).toEqual(['aaaa0001', 'bbbb0002']);
  });

  it('writes the file owner-only and leaves no temporary file', () => {
    recordSessionDeletion(file, 'aaaa0001');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['deletions.json']);
  });

  it('records a deleted chunk by digest, never by its text', () => {
    recordChunkDeletion(file, 'secret token ABC');
    recordChunkDeletion(file, 'secret token ABC');
    expect([...loadDeletions(file).chunkDigests]).toEqual([contentDigest('secret token ABC')]);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('secret token ABC');
  });

  it('keeps sessions and chunks independent in one file', () => {
    recordChunkDeletion(file, 'x');
    recordSessionDeletion(file, 'cccc0003');
    const d = loadDeletions(file);
    expect([...d.sessions]).toEqual(['cccc0003']);
    expect([...d.chunkDigests]).toEqual([contentDigest('x')]);
  });

  it('fails with the file path when the file is malformed, keeping the parse error as cause', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(() => loadDeletions(file)).toThrow(file);
    try {
      loadDeletions(file);
    } catch (err) {
      expect((err as Error).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it('ignores entries of the wrong type instead of trusting them', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessions: ['ok01', 3], chunkDigests: 'nope' }));
    const d = loadDeletions(file);
    expect([...d.sessions]).toEqual(['ok01']);
    expect([...d.chunkDigests]).toEqual([]);
  });

  it('uses a SHA-256 hex digest', () => {
    expect(contentDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  describe('redactTurnText', () => {
    const long = `[User]\n${'a'.repeat(3000)}\n\n[Assistant]\n${'b'.repeat(3000)}`;

    it('returns the text unchanged when nothing is deleted', () => {
      expect(redactTurnText(long, new Set())).toBe(long);
    });

    it('replaces only the deleted part, using the same split as the chunker', () => {
      const parts = splitTurnText(long, 512);
      expect(parts.length).toBeGreaterThan(1);
      const out = redactTurnText(long, new Set([contentDigest(parts[1])]));
      expect(out).toBe([parts[0], '[deleted]', ...parts.slice(2)].join('\n\n'));
    });

    it('keeps the original text, including extra blank lines, when no part is deleted', () => {
      const text = `[User]\n${'a'.repeat(3000)}\n\n\n[Assistant]\n${'b'.repeat(3000)}`;
      expect(redactTurnText(text, new Set([contentDigest('unrelated')]))).toBe(text);
    });

    it('replaces a whole short turn', () => {
      const text = '[User]\nhello\n\n[Assistant]\nhi';
      expect(redactTurnText(text, new Set([contentDigest(text)]))).toBe('[deleted]');
    });
  });
});
