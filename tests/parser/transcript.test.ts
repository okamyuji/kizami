import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseTranscript, parseTranscriptText } from '../../src/parser/transcript';
import type { AssistantMessage } from '../../src/parser/transcript';

const FIXTURE = path.resolve(__dirname, '../fixtures/sample-transcript.jsonl');

describe('parseTranscript', () => {
  it('skips malformed external content blocks without throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-transcript-'));
    const file = path.join(dir, 'malformed.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 42,
          timestamp: { malformed: true },
          message: { role: 'user', content: [null, 1, { type: 'text', text: 'valid' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 's',
          message: {
            role: 'assistant',
            content: [
              null,
              { type: 'tool_use', id: 'missing-input', name: 'Bash' },
              { type: 'text', text: 'answer' },
            ],
          },
        }),
      ].join('\n')
    );

    await expect(parseTranscript(file)).resolves.toMatchObject([
      { kind: 'user', sessionId: '', timestamp: undefined, text: 'valid' },
      { kind: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ]);
  });

  it('attaches user tool_result blocks with is_error to the prior assistant', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-transcript-'));
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'assistant',
          sessionId: 's',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'false' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 's',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'c1', content: 'failed', is_error: true },
            ],
          },
        }),
      ].join('\n')
    );
    const messages = await parseTranscript(file);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe('assistant');
    if (messages[0].kind === 'assistant') {
      expect(messages[0].toolResults[0]).toMatchObject({
        toolUseId: 'c1',
        content: 'failed',
        isError: true,
      });
    }
  });
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
    // The summary line should produce no message
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

describe('parseTranscriptText', () => {
  it('gives the same messages as parseTranscript for the same file', async () => {
    const fixture = path.resolve(__dirname, '../fixtures/sample-transcript.jsonl');
    expect(parseTranscriptText(fs.readFileSync(fixture, 'utf-8'))).toEqual(
      await parseTranscript(fixture)
    );
  });

  it('skips blank and malformed lines', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(parseTranscriptText(`\n{oops\n${line}\r\n`).map((m) => m.kind)).toEqual(['user']);
  });

  it('reads a line that starts with a BOM or a no-break space', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(parseTranscriptText(`\uFEFF${line}\n\u00A0${line}`)).toHaveLength(2);
  });

  it('skips JSON lines that are not objects and compaction summaries that carry a message', () => {
    const summary = JSON.stringify({
      isCompactSummary: true,
      message: { role: 'user', content: 'summary text' },
    });
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(parseTranscriptText(`null\n42\n${summary}\n${line}`)).toEqual([
      expect.objectContaining({ kind: 'user', text: 'hi' }),
    ]);
  });
});

describe('parseTranscriptText timestamps', () => {
  const line = (timestamp: unknown) =>
    JSON.stringify({
      type: 'user',
      sessionId: 's',
      timestamp,
      message: { role: 'user', content: 'hello' },
    });
  const stamp = (timestamp: unknown) => parseTranscriptText(line(timestamp))[0].timestamp;

  it('keeps a valid ISO timestamp as written', () => {
    expect(stamp('2026-10-05T06:44:12.345Z')).toBe('2026-10-05T06:44:12.345Z');
    expect(stamp('2024-06-15T10:00:00Z')).toBe('2024-06-15T10:00:00Z');
    expect(stamp('2026-10-05T06:44:12.345678Z')).toBe('2026-10-05T06:44:12.345678Z');
  });

  it('ignores a timestamp that is not a date', () => {
    expect(stamp('zzz-not-a-date')).toBeUndefined();
    expect(stamp('')).toBeUndefined();
    expect(stamp(2020)).toBeUndefined();
  });

  it('normalizes a parseable timestamp that is not in UTC ISO form', () => {
    expect(stamp('Oct 5 2026 10:00:00 GMT')).toBe('2026-10-05T10:00:00.000Z');
    expect(stamp('2026-10-05T19:00:00+09:00')).toBe('2026-10-05T10:00:00.000Z');
  });

  it('ignores a timestamp far in the future', () => {
    expect(stamp('9999-12-31T00:00:00Z')).toBeUndefined();
  });

  it('accepts a timestamp up to one day ahead and rejects anything later', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-17T12:00:00.000Z') });
    try {
      expect(stamp('2026-10-18T12:00:00.000Z')).toBe('2026-10-18T12:00:00.000Z');
      expect(stamp('2026-10-18T12:00:00.001Z')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
