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
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const BYTE_TRUNCATION_MARKER = '\n...(truncated by byte limit)...\n';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateToolOutput(output: string): string {
  const lineLimited = limitToolOutputLines(output);
  if (Buffer.byteLength(lineLimited, 'utf-8') <= MAX_TOOL_OUTPUT_BYTES) return lineLimited;

  const markerBytes = Buffer.byteLength(BYTE_TRUNCATION_MARKER, 'utf-8');
  const availableBytes = MAX_TOOL_OUTPUT_BYTES - markerBytes;
  const headBytes = Math.floor(availableBytes * 0.8);
  const tailBytes = availableBytes - headBytes;
  return `${takePrefixByBytes(lineLimited, headBytes)}${BYTE_TRUNCATION_MARKER}${takeSuffixByBytes(
    lineLimited,
    tailBytes
  )}`;
}

function limitToolOutputLines(output: string): string {
  let newline = -1;
  // Stryker disable next-line all: headEndはループ内で必ず上書きされ初期値は挙動に影響しない
  let headEnd = -1;
  for (let count = 1; count <= MAX_TOOL_HEAD + MAX_TOOL_TAIL; count++) {
    newline = output.indexOf('\n', newline + 1);
    if (newline === -1) return output;
    if (count === MAX_TOOL_HEAD) headEnd = newline;
  }
  // 上限行数目の改行が末尾改行なら内容は25行以内なので切り詰めない
  if (newline === output.length - 1) return output;

  // 末尾文字が改行ならtail行として数えない。改行以外ならlastIndexOfは同じ改行に到達するため常に-1でよい
  let tailStart = output.length - 1;
  for (let count = 0; count < MAX_TOOL_TAIL; count++) {
    const previousNewline = output.lastIndexOf('\n', tailStart - 1);
    // Stryker disable next-line all: 26行以上が確定しており-1は到達不能な防御
    if (previousNewline === -1) return output;
    tailStart = previousNewline;
  }

  return `${output.slice(0, headEnd)}\n...(truncated)\n${output.slice(tailStart + 1)}`;
}

function takePrefixByBytes(value: string, byteLimit: number): string {
  let result = '';
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf-8');
    if (usedBytes + characterBytes > byteLimit) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

function takeSuffixByBytes(value: string, byteLimit: number): string {
  let start = value.length;
  let usedBytes = 0;
  while (start > 0) {
    let characterStart = start - 1;
    const lastUnit = value.charCodeAt(characterStart);
    if (lastUnit >= 0xdc00 && lastUnit <= 0xdfff && characterStart > 0) {
      const previousUnit = value.charCodeAt(characterStart - 1);
      if (previousUnit >= 0xd800 && previousUnit <= 0xdbff) characterStart--;
    }
    const character = value.slice(characterStart, start);
    const characterBytes = Buffer.byteLength(character, 'utf-8');
    if (usedBytes + characterBytes > byteLimit) break;
    usedBytes += characterBytes;
    start = characterStart;
  }
  return value.slice(start);
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
