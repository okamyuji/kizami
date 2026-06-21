import { describe, it, expect } from 'vitest';
import { buildCheckpointParts } from '../../src/checkpoint/builder';
import type { TurnCheckpointCandidate } from '../../src/checkpoint/types';
import type { TranscriptMessage } from '../../src/parser/transcript';

function makeCandidate(
  text: string,
  options: {
    role?: 'human' | 'assistant' | 'mixed';
    turnKey?: string;
    runtime?: 'claude' | 'codex' | 'kimi';
  } = {}
): TurnCheckpointCandidate {
  const role = options.role ?? 'mixed';
  const messages: TranscriptMessage[] = [];

  if (role === 'human') {
    messages.push({ kind: 'user', sessionId: 'sess-1', text });
  } else if (role === 'assistant') {
    messages.push({
      kind: 'assistant',
      sessionId: 'sess-1',
      content: [{ type: 'text', text }],
      toolResults: [],
    });
  } else {
    messages.push({ kind: 'user', sessionId: 'sess-1', text: 'prompt' });
    messages.push({
      kind: 'assistant',
      sessionId: 'sess-1',
      content: [{ type: 'text', text }],
      toolResults: [],
    });
  }

  return {
    runtime: options.runtime ?? 'claude',
    sessionId: 'sess-1',
    turnKey: options.turnKey ?? 'turn-key-1',
    sourceOrder: '00000000000000000001',
    observedThrough: { kind: 'source_offset', generation: 1, offset: 100 },
    projectPath: '/project',
    completedAt: new Date().toISOString(),
    prompt: 'prompt',
    assistant: text,
    messages,
  };
}

describe('buildCheckpointParts', () => {
  it('returns stable sequential part indices', () => {
    const parts = buildCheckpointParts(makeCandidate('paragraph\n\n'.repeat(600)));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => part.partIndex)).toEqual(parts.map((_, index) => index));
  });

  it('splits one long turn into multiple parts', () => {
    const parts = buildCheckpointParts(makeCandidate('paragraph\n\n'.repeat(600)));
    expect(parts.length).toBeGreaterThan(1);
    const combined = parts.map((p) => p.content).join('\n\n');
    expect(combined).toContain('[User]');
    expect(combined).toContain('[Assistant]');
  });

  it('detects human-only role', () => {
    const parts = buildCheckpointParts(makeCandidate('only human text', { role: 'human' }));
    expect(parts.length).toBe(1);
    expect(parts[0].role).toBe('human');
    expect(parts[0].content).toContain('[User]');
    expect(parts[0].content).not.toContain('[Assistant]');
  });

  it('detects assistant-only role', () => {
    const parts = buildCheckpointParts(makeCandidate('only assistant text', { role: 'assistant' }));
    expect(parts.length).toBe(1);
    expect(parts[0].role).toBe('assistant');
    expect(parts[0].content).toContain('[Assistant]');
    expect(parts[0].content).not.toContain('[User]');
  });

  it('detects mixed role for human plus assistant', () => {
    const parts = buildCheckpointParts(makeCandidate('assistant reply'));
    expect(parts.length).toBe(1);
    expect(parts[0].role).toBe('mixed');
    expect(parts[0].content).toContain('[User]');
    expect(parts[0].content).toContain('[Assistant]');
  });

  it('estimates token counts as ceil(chars / 4)', () => {
    const parts = buildCheckpointParts(makeCandidate('hello world', { role: 'human' }));
    const content = parts[0].content;
    expect(parts[0].tokenCount).toBe(Math.ceil(content.length / 4));
  });

  it('produces stable external IDs across repeated calls', () => {
    const candidate = makeCandidate('assistant reply', { turnKey: 'stable-key' });
    const first = buildCheckpointParts(candidate);
    const second = buildCheckpointParts(candidate);
    expect(first.map((p) => p.externalId)).toEqual(second.map((p) => p.externalId));
  });

  it('distinguishes external IDs by part index', () => {
    const parts = buildCheckpointParts(makeCandidate('paragraph\n\n'.repeat(600)));
    const ids = parts.map((p) => p.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('extracts metadata from content', () => {
    const parts = buildCheckpointParts(
      makeCandidate('Look at src/app.ts and run [Tool: Bash] cat src/app.ts', {
        role: 'assistant',
      })
    );
    expect(parts[0].metadata.filePaths).toContain('src/app.ts');
    expect(parts[0].metadata.toolNames).toContain('Bash');
  });
});
