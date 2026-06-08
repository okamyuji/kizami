import { describe, it, expect } from 'vitest';
import { parseKimiSessionStartInput, parseKimiPromptInput } from '../../src/hooks/kimi';

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
