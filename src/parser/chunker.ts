import type { Chunk } from '@/db/store';
import type {
  TranscriptMessage,
  AssistantMessage,
  TextContent,
  ToolUseContent,
} from '@/parser/transcript';
import { extractMetadata } from '@/parser/metadata';

export interface Turn {
  human: string;
  assistant: string;
}

export const MAX_TOOL_HEAD = 20;
export const MAX_TOOL_TAIL = 5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateToolOutput(output: string): string {
  const lines = output.split('\n');
  if (lines.length <= MAX_TOOL_HEAD + MAX_TOOL_TAIL) return output;
  const head = lines.slice(0, MAX_TOOL_HEAD).join('\n');
  const tail = lines.slice(-MAX_TOOL_TAIL).join('\n');
  return `${head}\n...(truncated)\n${tail}`;
}

export function formatAssistant(msg: AssistantMessage): string {
  const parts: string[] = [];

  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push((block as TextContent).text);
    } else if (block.type === 'tool_use') {
      const tool = block as ToolUseContent;
      const input = tool.input.command ?? tool.input.content ?? JSON.stringify(tool.input);
      parts.push(`[Tool: ${tool.name}] ${String(input)}`);
    }
  }

  for (const result of msg.toolResults) {
    parts.push(truncateToolOutput(result.content));
  }

  return parts.join('\n');
}

export function buildTurns(messages: TranscriptMessage[]): Turn[] {
  const turns: Turn[] = [];
  let currentHuman = '';
  let currentAssistant = '';

  for (const msg of messages) {
    if (msg.kind === 'user') {
      // If we have a pending turn, push it
      if (currentHuman || currentAssistant) {
        turns.push({ human: currentHuman, assistant: currentAssistant });
        currentAssistant = '';
      }
      currentHuman = msg.text;
    } else {
      const formatted = formatAssistant(msg);
      currentAssistant = currentAssistant ? `${currentAssistant}\n${formatted}` : formatted;
    }
  }

  // Push final turn
  if (currentHuman || currentAssistant) {
    turns.push({ human: currentHuman, assistant: currentAssistant });
  }

  return turns;
}

export function turnToText(turn: Turn): string {
  const parts: string[] = [];
  if (turn.human) parts.push(`[User]\n${turn.human}`);
  if (turn.assistant) parts.push(`[Assistant]\n${turn.assistant}`);
  return parts.join('\n\n');
}

export function splitAtBoundaries(text: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  // Split on double newlines (paragraph/code block boundaries)
  const paragraphs = text.split(/\n{2,}/);
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (estimateTokens(candidate) > maxTokens && current) {
      chunks.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

export function splitTurnText(text: string, maxTokens = 512): string[] {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) {
    return [text];
  }
  return splitAtBoundaries(text, maxTokens);
}

export function detectRole(content: string): 'human' | 'assistant' | 'mixed' {
  const hasUser = content.includes('[User]');
  const hasAssistant = content.includes('[Assistant]');
  if (hasUser && hasAssistant) {
    return 'mixed';
  } else if (hasAssistant) {
    return 'assistant';
  } else {
    return 'human';
  }
}

export function buildChunks(
  messages: TranscriptMessage[],
  sessionId: string,
  projectPath: string
): Chunk[] {
  const turns = buildTurns(messages);
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const turn of turns) {
    const text = turnToText(turn);

    for (const content of splitTurnText(text, 512)) {
      const metadata = extractMetadata(content);
      const role = detectRole(content);

      chunks.push({
        sessionId,
        projectPath,
        chunkIndex,
        content,
        role,
        metadata,
        tokenCount: estimateTokens(content),
      });
      chunkIndex++;
    }
  }

  return chunks;
}
