import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseTranscript,
  parseTranscriptText,
  conversationTime,
} from '../../src/parser/transcript';
import type { AssistantMessage } from '../../src/parser/transcript';

const FIXTURE = path.resolve(__dirname, '../fixtures/sample-transcript.jsonl');

describe('parseTranscript', () => {
  it('keeps a line that holds a raw U+2028 or U+2029 and handles CRLF and a missing final newline', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-transcript-'));
    const file = path.join(dir, 'sep.jsonl');
    const user = (text: string) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    fs.writeFileSync(file, `${user('a\u2028b\u2029c')}\r\n${user('second')}`);
    const messages = await parseTranscript(file);
    expect(messages).toMatchObject([{ text: 'a\u2028b\u2029c' }, { text: 'second' }]);
    expect(messages).toHaveLength(2);
    expect(messages).toEqual(parseTranscriptText(fs.readFileSync(file, 'utf-8')));
  });

  it('parses lines that span stream chunks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-transcript-'));
    const file = path.join(dir, 'big.jsonl');
    const text = '\u20ac'.repeat(100_000);
    fs.writeFileSync(
      file,
      JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
    );
    expect(await parseTranscript(file)).toMatchObject([{ text }]);
  });

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
  it('reads request copies and every other line with a role only when asked, as versions before 0.8.6 did', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'q' } }),
      JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: 'copy' } }),
      JSON.stringify({ type: 'api-request-blob', message: { role: 'system', content: 'sys' } }),
      JSON.stringify({ type: 'attachment', message: { role: 'user', content: 'other' } }),
    ].join('\n');

    expect(parseTranscriptText(text).map((m) => m.kind === 'user' && m.text)).toEqual(['q']);
    expect(
      parseTranscriptText(text, { requestCopies: true }).map((m) => m.kind === 'user' && m.text)
    ).toEqual(['q', 'copy', 'other']);
  });

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

  it('reads only user and assistant lines and skips api-request-blob copies of the request', () => {
    const lines = [
      { type: 'user', message: { role: 'user', content: 'question' } },
      {
        type: 'api-request-blob',
        message: { role: 'user', content: '<system-reminder>context</system-reminder>' },
      },
      {
        type: 'api-request-blob',
        message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
      },
      { message: { role: 'user', content: 'no type' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
    ];
    const messages = parseTranscriptText(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(messages).toEqual([
      expect.objectContaining({ kind: 'user', text: 'question' }),
      expect.objectContaining({ kind: 'assistant', content: [{ type: 'text', text: 'a' }] }),
    ]);
  });

  const toText = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');
  const assistant = { type: 'assistant', message: { role: 'assistant', content: [] } };

  it('attaches a toolUseResult to the last assistant even when a user turn follows it', () => {
    const messages = parseTranscriptText(
      toText([
        assistant,
        { type: 'user', message: { role: 'user', content: 'next' } },
        {
          type: 'user',
          toolUseResult: { tool_use_id: 't1', content: 'out', is_error: true },
        },
      ])
    );
    expect((messages[0] as AssistantMessage).toolResults).toEqual([
      { toolUseId: 't1', content: 'out', isError: true },
    ]);
  });

  it('replaces toolUseResult fields of the wrong type with empty values', () => {
    const messages = parseTranscriptText(
      toText([
        assistant,
        { type: 'user', toolUseResult: { tool_use_id: 7, content: ['x'], is_error: 'yes' } },
      ])
    );
    expect((messages[0] as AssistantMessage).toolResults).toEqual([
      { toolUseId: '', content: '', isError: undefined },
    ]);
  });

  it('joins array tool_result text, uses an empty string for missing content, and ignores text blocks', () => {
    const messages = parseTranscriptText(
      toText([
        assistant,
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'a',
                content: [{ text: 'x' }, {}, { text: 'y' }],
              },
              { type: 'tool_result', tool_use_id: 'b' },
              { type: 'text', text: 'typed' },
            ],
          },
        },
      ])
    );
    expect(messages).toHaveLength(2);
    expect((messages[0] as AssistantMessage).toolResults).toEqual([
      { toolUseId: 'a', content: 'xy', isError: undefined },
      { toolUseId: 'b', content: '', isError: undefined },
    ]);
  });

  it('skips user and assistant lines without a message object or with another role', () => {
    const messages = parseTranscriptText(
      toText([
        { type: 'user' },
        { type: 'user', message: null },
        { type: 'assistant', message: { role: 'system', content: [{ type: 'text', text: 's' }] } },
      ])
    );
    expect(messages).toEqual([]);
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

describe('conversationTime', () => {
  const NOW = new Date('2026-10-17T12:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  it('prefers the transcript timestamp', () => {
    expect(conversationTime('2026-09-01T00:00:00Z', new Date('2026-10-01T00:00:00Z'))).toBe(
      '2026-09-01T00:00:00Z'
    );
  });

  it('falls back to the file mtime as ISO', () => {
    expect(conversationTime(undefined, new Date('2026-10-01T00:00:00.123Z'))).toBe(
      '2026-10-01T00:00:00.123Z'
    );
  });

  it('clamps an mtime beyond one day ahead to the same bound as timestamps', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    try {
      const bound = new Date(NOW.getTime() + DAY);
      expect(conversationTime(undefined, bound)).toBe(bound.toISOString());
      expect(conversationTime(undefined, new Date(bound.getTime() + 1))).toBe(bound.toISOString());
      expect(conversationTime(undefined, new Date('2036-10-14T00:00:00Z'))).toBe(
        bound.toISOString()
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
