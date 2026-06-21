import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  parseKimiSessionStartInput,
  parseKimiPromptInput,
  parseKimiSessionEndInput,
  savePendingKimiPrompt,
  collectPendingKimiTurns,
  extractAssistantFromWireJsonl,
} from '../../src/hooks/kimi';

describe('parseKimiSessionStartInput', () => {
  it('should parse valid SessionStart JSON', () => {
    const raw = JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'sess_abc',
      cwd: '/project',
      source: 'startup',
    });
    const result = parseKimiSessionStartInput(raw);
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('sess_abc');
    expect(result!.cwd).toBe('/project');
  });

  it('should return null when session_id is missing', () => {
    const raw = JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/project' });
    expect(parseKimiSessionStartInput(raw)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseKimiSessionStartInput('')).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    expect(parseKimiSessionStartInput('not-json')).toBeNull();
  });

  it('should handle missing optional fields gracefully', () => {
    const raw = JSON.stringify({ session_id: 'sess_123' });
    const result = parseKimiSessionStartInput(raw);
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('sess_123');
    expect(result!.cwd).toBeUndefined();
  });
});

describe('parseKimiPromptInput', () => {
  it('should parse valid UserPromptSubmit JSON with prompt', () => {
    const raw = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess_abc',
      cwd: '/project',
      prompt: 'How do I test this?',
    });
    const result = parseKimiPromptInput(raw);
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('sess_abc');
    expect(result!.prompt).toBe('How do I test this?');
  });

  it('should parse prompt from array format (kimi-code v0.11+)', () => {
    const raw = JSON.stringify({
      session_id: 'sess_abc',
      cwd: '/project',
      prompt: [{ type: 'text', text: 'How do I test this?' }],
    });
    const result = parseKimiPromptInput(raw);
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe('How do I test this?');
  });

  it('should join multiple text parts from array prompt', () => {
    const raw = JSON.stringify({
      session_id: 'sess_abc',
      prompt: [
        { type: 'text', text: 'Part 1' },
        { type: 'image', url: 'http://example.com/img.png' },
        { type: 'text', text: 'Part 2' },
      ],
    });
    const result = parseKimiPromptInput(raw);
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe('Part 1\nPart 2');
  });

  it('should return result with undefined prompt when prompt field is missing', () => {
    const raw = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess_abc',
      cwd: '/project',
    });
    const result = parseKimiPromptInput(raw);
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('sess_abc');
    expect(result!.prompt).toBeUndefined();
  });

  it('should trim whitespace-only prompt to empty string', () => {
    const raw = JSON.stringify({
      session_id: 'sess_abc',
      prompt: '   ',
    });
    const result = parseKimiPromptInput(raw);
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe('');
  });

  it('should return null when session_id is missing', () => {
    const raw = JSON.stringify({ prompt: 'hello' });
    expect(parseKimiPromptInput(raw)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseKimiPromptInput('')).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    expect(parseKimiPromptInput('{bad')).toBeNull();
  });
});

describe('parseKimiSessionEndInput', () => {
  it('should parse valid SessionEnd JSON', () => {
    const raw = JSON.stringify({
      hook_event_name: 'SessionEnd',
      session_id: 'sess_abc',
      cwd: '/project',
      reason: 'exit',
    });
    const result = parseKimiSessionEndInput(raw);
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('sess_abc');
    expect(result!.reason).toBe('exit');
  });

  it('should return null when session_id is missing', () => {
    expect(parseKimiSessionEndInput(JSON.stringify({ reason: 'exit' }))).toBeNull();
  });
});

describe('pending file operations', () => {
  let tmpDir: string;
  let pendingDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-kimi-'));
    pendingDir = path.join(tmpDir, 'pending', 'kimi');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should save and collect pending prompts for a session', () => {
    savePendingKimiPrompt(
      { session_id: 'sess_1', cwd: '/project', prompt: 'What is this?' },
      pendingDir
    );
    savePendingKimiPrompt(
      { session_id: 'sess_1', cwd: '/project', prompt: 'How to fix?' },
      pendingDir
    );
    const turns = collectPendingKimiTurns('sess_1', pendingDir);
    expect(turns).toHaveLength(2);
  });

  it('should not collect turns from other sessions', () => {
    savePendingKimiPrompt({ session_id: 'sess_1', cwd: '/project', prompt: 'Q1' }, pendingDir);
    savePendingKimiPrompt({ session_id: 'sess_2', cwd: '/project', prompt: 'Q2' }, pendingDir);
    expect(collectPendingKimiTurns('sess_1', pendingDir)).toHaveLength(1);
  });

  it('should retain pending files older than 24 hours', () => {
    savePendingKimiPrompt({ session_id: 'sess_1', cwd: '/project', prompt: 'old' }, pendingDir);
    const files = fs.readdirSync(pendingDir);
    const filePath = path.join(pendingDir, files[0]);
    const pending = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    pending.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(filePath, JSON.stringify(pending));
    const turns = collectPendingKimiTurns('sess_1', pendingDir);
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe('old');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('should not save when prompt is empty', () => {
    savePendingKimiPrompt({ session_id: 'sess_1', cwd: '/project', prompt: '' }, pendingDir);
    expect(fs.existsSync(pendingDir)).toBe(false);
  });

  it('should clean up collected pending files', () => {
    savePendingKimiPrompt({ session_id: 'sess_1', cwd: '/project', prompt: 'Q1' }, pendingDir);
    collectPendingKimiTurns('sess_1', pendingDir, true);
    const remaining = fs.readdirSync(pendingDir).filter((f) => f.includes('sess_1'));
    expect(remaining).toHaveLength(0);
  });
});

describe('extractAssistantFromWireJsonl', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-wire-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeWire(entries: object[]): string {
    const wirePath = path.join(tmpDir, 'wire.jsonl');
    fs.writeFileSync(wirePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return wirePath;
  }

  it('should extract last assistant text from content.part events', () => {
    const wp = writeWire([
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: 'Hello, ' } },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: 'world!' } },
      },
    ]);
    expect(extractAssistantFromWireJsonl(wp)).toBe('Hello, world!');
  });

  it('should extract only the last turn after step.begin', () => {
    const wp = writeWire([
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: 'first' } },
      },
      { type: 'context.append_loop_event', event: { type: 'step.end' } },
      { type: 'context.append_loop_event', event: { type: 'step.begin' } },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: 'second' } },
      },
    ]);
    expect(extractAssistantFromWireJsonl(wp)).toBe('second');
  });

  it('should skip think parts', () => {
    const wp = writeWire([
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'think', think: 'hmm' } },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: 'answer' } },
      },
    ]);
    expect(extractAssistantFromWireJsonl(wp)).toBe('answer');
  });

  it('should return empty string for nonexistent file', () => {
    expect(extractAssistantFromWireJsonl('/nonexistent')).toBe('');
  });
});
