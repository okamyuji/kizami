import type { TranscriptMessage, ToolUseContent } from '@/parser/transcript';
import { truncateToolOutput } from '@/parser/chunker';
import type { ExecutionObservationV1 } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function extractClaudeExecutions(messages: TranscriptMessage[]): ExecutionObservationV1[] {
  const observations: ExecutionObservationV1[] = [];

  for (const message of messages) {
    if (message.kind !== 'assistant') continue;
    const results = new Map<string, typeof message.toolResults>();
    for (const result of message.toolResults) {
      const current = results.get(result.toolUseId) ?? [];
      current.push(result);
      results.set(result.toolUseId, current);
    }

    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const tool = block as ToolUseContent;
      const input: unknown = tool.input;
      if (!isRecord(input)) continue;
      const command = input.command;
      if (typeof command !== 'string') continue;
      const matches = results.get(tool.id) ?? [];
      if (matches.length === 0) continue;

      const first = matches[0];
      const conflicting = matches.some(
        (result) => result.content !== first.content || result.isError !== first.isError
      );
      const status = conflicting
        ? 'unknown'
        : first.isError === true
          ? 'failed'
          : first.isError === false
            ? 'succeeded'
            : 'unknown';

      observations.push({
        executionIndex: observations.length,
        toolName: tool.name,
        command,
        status,
        outputExcerpt: truncateToolOutput(first.content),
      });
    }
  }

  return observations;
}
