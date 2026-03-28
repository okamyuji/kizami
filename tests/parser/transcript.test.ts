import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseTranscript } from '../../src/parser/transcript';
import type { AssistantMessage } from '../../src/parser/transcript';

const FIXTURE = path.resolve(__dirname, '../fixtures/sample-transcript.jsonl');

describe('parseTranscript', () => {
  it('should parse user and assistant messages', async () => {
    const messages = await parseTranscript(FIXTURE);
    // 2 user messages + 4 assistant messages (compaction summary excluded, tool results attached)
    const userMsgs = messages.filter((m) => m.kind === 'user');
    const assistantMsgs = messages.filter((m) => m.kind === 'assistant');

    expect(userMsgs.length).toBe(2);
    expect(assistantMsgs.length).toBe(4);
  });

  it('should extract user text correctly', async () => {
    const messages = await parseTranscript(FIXTURE);
    const first = messages[0];
    expect(first.kind).toBe('user');
    if (first.kind === 'user') {
      expect(first.text).toContain('Express server');
    }
  });

  it('should skip compaction summaries', async () => {
    const messages = await parseTranscript(FIXTURE);
    // The summary line should not produce any message
    const allTexts = messages.map((m) => (m.kind === 'user' ? m.text : ''));
    expect(allTexts.some((t) => t.includes('User asked to create'))).toBe(false);
  });

  it('should attach tool results to preceding assistant message', async () => {
    const messages = await parseTranscript(FIXTURE);
    const firstAssistant = messages.find((m) => m.kind === 'assistant') as AssistantMessage;
    expect(firstAssistant.toolResults.length).toBe(1);
    expect(firstAssistant.toolResults[0].content).toBe('File written successfully');
  });

  it('should preserve sessionId and timestamp', async () => {
    const messages = await parseTranscript(FIXTURE);
    expect(messages[0].sessionId).toBe('sess-abc123');
    if (messages[0].kind === 'user') {
      expect(messages[0].timestamp).toBe('2024-06-15T10:00:00Z');
    }
  });

  it('should parse assistant content blocks including tool_use', async () => {
    const messages = await parseTranscript(FIXTURE);
    const firstAssistant = messages.find((m) => m.kind === 'assistant') as AssistantMessage;
    expect(firstAssistant.content.length).toBe(2);
    expect(firstAssistant.content[0].type).toBe('text');
    expect(firstAssistant.content[1].type).toBe('tool_use');
  });
});
