import { describe, it, expect } from 'vitest';
import { buildChunks, MAX_TOOL_OUTPUT_BYTES, truncateToolOutput } from '../../src/parser/chunker';
import type { TranscriptMessage, AssistantMessage, UserMessage } from '../../src/parser/transcript';

function makeUser(text: string, timestamp?: string): UserMessage {
  return { kind: 'user', sessionId: 'sess-1', text, timestamp };
}

function makeAssistant(
  text: string,
  toolResults: AssistantMessage['toolResults'] = [],
  timestamp?: string
): AssistantMessage {
  return {
    kind: 'assistant',
    sessionId: 'sess-1',
    content: [{ type: 'text', text }],
    toolResults,
    timestamp,
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

  it('should stamp each chunk with the timestamp of the turn it came from', () => {
    const messages: TranscriptMessage[] = [
      makeUser('First question', '2026-10-05T06:44:00.000Z'),
      makeAssistant('First answer', [], '2026-10-05T06:44:30.000Z'),
      makeUser('Second question', '2026-10-05T08:17:00.000Z'),
      makeAssistant('Second answer', [], '2026-10-05T08:17:30.000Z'),
    ];
    const chunks = buildChunks(messages, 'sess-1', '/project');

    expect(chunks.map((c) => c.createdAt)).toEqual([
      '2026-10-05T06:44:00.000Z',
      '2026-10-05T08:17:00.000Z',
    ]);
  });

  it('should stamp every split chunk of one turn with the turn timestamp', () => {
    const long = Array.from({ length: 40 }, (_, i) => `paragraph ${i} ${'x'.repeat(200)}`).join(
      '\n\n'
    );
    const messages: TranscriptMessage[] = [
      makeUser('Q', '2026-10-05T06:44:00.000Z'),
      makeAssistant(long, [], '2026-10-05T06:50:00.000Z'),
    ];
    const chunks = buildChunks(messages, 'sess-1', '/project');

    expect(chunks.length).toBeGreaterThan(1);
    expect(new Set(chunks.map((c) => c.createdAt))).toEqual(new Set(['2026-10-05T06:44:00.000Z']));
  });

  it('should use the first assistant timestamp when the turn has no user message', () => {
    const messages: TranscriptMessage[] = [
      makeAssistant('Orphan', [], '2026-10-05T06:44:30.000Z'),
      makeAssistant('More', [], '2026-10-05T06:45:00.000Z'),
    ];
    const chunks = buildChunks(messages, 'sess-1', '/project');

    expect(chunks[0].createdAt).toBe('2026-10-05T06:44:30.000Z');
  });

  it('should fall back to the assistant timestamp when the user line has none', () => {
    const messages: TranscriptMessage[] = [
      makeUser('Q'),
      makeAssistant('A', [], '2026-10-05T06:44:30.000Z'),
    ];
    const chunks = buildChunks(messages, 'sess-1', '/project');

    expect(chunks[0].createdAt).toBe('2026-10-05T06:44:30.000Z');
  });

  it('should not leak the previous turn timestamp into a turn without timestamps', () => {
    const messages: TranscriptMessage[] = [
      makeUser('First', '2026-10-05T06:44:00.000Z'),
      makeAssistant('A1'),
      makeUser('Second'),
      makeAssistant('A2'),
    ];
    const chunks = buildChunks(messages, 'sess-1', '/project');

    expect(chunks[0].createdAt).toBe('2026-10-05T06:44:00.000Z');
    expect(chunks[1].createdAt).toBeUndefined();
  });

  it('should leave createdAt unset when no message has a timestamp', () => {
    const chunks = buildChunks([makeUser('Hello'), makeAssistant('Hi')], 'sess-1', '/project');

    expect(chunks[0].createdAt).toBeUndefined();
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

  it('keeps exactly 25 lines without truncation regardless of a terminal newline', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');

    expect(truncateToolOutput(lines)).toBe(lines);
    expect(truncateToolOutput(`${lines}\n`)).toBe(`${lines}\n`);
  });

  it('keeps the last 5 content lines when the output ends with a newline', () => {
    const lines = Array.from({ length: 26 }, (_, i) => `line ${i + 1}`);
    const truncated = truncateToolOutput(`${lines.join('\n')}\n`);

    expect(truncated).toBe(
      `${lines.slice(0, 20).join('\n')}\n...(truncated)\n${lines.slice(21).join('\n')}\n`
    );
  });

  it('truncates 26 single-character lines to the exact head and tail', () => {
    const lines = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i));
    const truncated = truncateToolOutput(lines.join('\n'));

    expect(truncated).toBe(
      `${lines.slice(0, 20).join('\n')}\n...(truncated)\n${lines.slice(21).join('\n')}`
    );
  });

  it('limits a single-line tool output by UTF-8 bytes', () => {
    const output = truncateToolOutput(`first-${'あ'.repeat(100_000)}-last`);

    expect(Buffer.byteLength(output, 'utf-8')).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(output).toContain('first-');
    expect(output).toContain('-last');
    expect(output).toContain('...(truncated by byte limit)...');
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
