import { describe, expect, it } from 'vitest';
import { extractClaudeExecutions } from '@/execution/claude';
import type { TranscriptMessage } from '@/parser/transcript';

function assistant(isError?: boolean): TranscriptMessage {
  return {
    kind: 'assistant',
    sessionId: 's',
    content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'pnpm test' } }],
    toolResults: [{ toolUseId: 'call-1', content: 'error text', isError }],
  };
}

describe('extractClaudeExecutions', () => {
  it.each([
    [true, 'failed'],
    [false, 'succeeded'],
    [undefined, 'unknown'],
  ] as const)('maps is_error=%s to %s', (isError, status) => {
    expect(extractClaudeExecutions([assistant(isError)])[0].status).toBe(status);
  });

  it('does not infer status from error text', () => {
    expect(extractClaudeExecutions([assistant(false)])[0].status).toBe('succeeded');
  });

  it('omits calls without results or string commands', () => {
    const message = assistant(false);
    if (message.kind === 'assistant') message.toolResults = [];
    expect(extractClaudeExecutions([message])).toEqual([]);
    expect(
      extractClaudeExecutions([
        { kind: 'user', sessionId: 's', text: 'prompt' },
        {
          kind: 'assistant',
          sessionId: 's',
          content: [{ type: 'text', text: 'answer' }],
          toolResults: [{ toolUseId: 'call-1', content: 'unused', isError: false }],
        },
        {
          kind: 'assistant',
          sessionId: 's',
          content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 42 } }],
          toolResults: [{ toolUseId: 'call-1', content: 'unused', isError: false }],
        },
      ])
    ).toEqual([]);
  });

  it('marks conflicting duplicate results unknown', () => {
    const message = assistant(false);
    if (message.kind === 'assistant') {
      message.toolResults.push({ toolUseId: 'call-1', content: 'different', isError: true });
    }
    expect(extractClaudeExecutions([message])[0].status).toBe('unknown');
  });

  it.each([
    [{ toolUseId: 'call-1', content: 'different', isError: false }],
    [{ toolUseId: 'call-1', content: 'error text', isError: true }],
  ])('marks either content or status conflict unknown', (duplicate) => {
    const message = assistant(false);
    if (message.kind === 'assistant') message.toolResults.push(duplicate);
    expect(extractClaudeExecutions([message])[0].status).toBe('unknown');
  });

  it('truncates long output to head 20 and tail 5 lines', () => {
    const message = assistant(true);
    if (message.kind === 'assistant') {
      message.toolResults[0].content = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
    }
    const output = extractClaudeExecutions([message])[0].outputExcerpt;
    expect(output).toContain('line-0');
    expect(output).toContain('line-29');
    expect(output).toContain('...(truncated)');
    expect(output).not.toContain('line-21\n');
  });
});
