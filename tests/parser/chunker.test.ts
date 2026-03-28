import { describe, it, expect } from 'vitest';
import { buildChunks } from '../../src/parser/chunker';
import type { TranscriptMessage, AssistantMessage, UserMessage } from '../../src/parser/transcript';

function makeUser(text: string): UserMessage {
  return { kind: 'user', sessionId: 'sess-1', text };
}

function makeAssistant(
  text: string,
  toolResults: AssistantMessage['toolResults'] = []
): AssistantMessage {
  return {
    kind: 'assistant',
    sessionId: 'sess-1',
    content: [{ type: 'text', text }],
    toolResults,
  };
}

describe('buildChunks', () => {
  it('should produce a single chunk for small conversations', () => {
    const messages: TranscriptMessage[] = [makeUser('Hello'), makeAssistant('Hi there')];
    const chunks = buildChunks(messages, 'sess-1', '/project');

    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain('[User]');
    expect(chunks[0].content).toContain('[Assistant]');
    expect(chunks[0].role).toBe('mixed');
    expect(chunks[0].sessionId).toBe('sess-1');
    expect(chunks[0].projectPath).toBe('/project');
  });

  it('should create multiple turns from alternating messages', () => {
    const messages: TranscriptMessage[] = [
      makeUser('First question'),
      makeAssistant('First answer'),
      makeUser('Second question'),
      makeAssistant('Second answer'),
    ];
    const chunks = buildChunks(messages, 'sess-1', '/project');

    // Each turn is small, so each gets its own chunk
    expect(chunks.length).toBe(2);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[1].chunkIndex).toBe(1);
  });

  it('should truncate long tool output', () => {
    const longOutput = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const messages: TranscriptMessage[] = [
      makeUser('Run something'),
      makeAssistant('Running', [{ toolUseId: 'tool-1', content: longOutput }]),
    ];
    const chunks = buildChunks(messages, 'sess-1', '/project');

    expect(chunks[0].content).toContain('...(truncated)');
    expect(chunks[0].content).toContain('line 1');
    expect(chunks[0].content).toContain('line 50');
    // Middle lines should be omitted
    expect(chunks[0].content).not.toContain('line 30');
  });

  it('should split large turns into multiple chunks', () => {
    // Create a turn with > 512 tokens (> ~2048 chars)
    const longText = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: ${'x'.repeat(80)}`).join(
      '\n\n'
    );
    const messages: TranscriptMessage[] = [makeUser('Question'), makeAssistant(longText)];
    const chunks = buildChunks(messages, 'sess-1', '/project');

    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should have sequential indices
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  it('should estimate token count as chars/4', () => {
    const messages: TranscriptMessage[] = [makeUser('Hello'), makeAssistant('World')];
    const chunks = buildChunks(messages, 'sess-1', '/project');
    const content = chunks[0].content;
    expect(chunks[0].tokenCount).toBe(Math.ceil(content.length / 4));
  });

  it('should extract metadata from chunk content', () => {
    const messages: TranscriptMessage[] = [
      makeUser('Fix the bug in src/app.ts'),
      makeAssistant('[Tool: Bash] cat src/app.ts', [
        { toolUseId: 'tool-1', content: 'Error: module not found' },
      ]),
    ];
    const chunks = buildChunks(messages, 'sess-1', '/project');

    expect(chunks[0].metadata.filePaths).toContain('src/app.ts');
    expect(chunks[0].metadata.toolNames).toContain('Bash');
    expect(chunks[0].metadata.errorMessages.length).toBeGreaterThan(0);
  });

  it('should return empty array for empty messages', () => {
    const chunks = buildChunks([], 'sess-1', '/project');
    expect(chunks).toEqual([]);
  });
});
