import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type?: string; text?: string }>;
  is_error?: boolean;
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent;

export interface UserMessage {
  kind: 'user';
  sessionId: string;
  timestamp?: string;
  text: string;
}

export interface AssistantMessage {
  kind: 'assistant';
  sessionId: string;
  timestamp?: string;
  content: ContentBlock[];
  toolResults: ToolResult[];
}

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type TranscriptMessage = UserMessage | AssistantMessage;

interface RawLine {
  type?: string;
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
  };
  sessionId?: string;
  timestamp?: string;
  isCompactSummary?: boolean;
  summary?: string;
  toolUseResult?: {
    type?: string;
    tool_use_id?: string;
    content?: string;
    is_error?: boolean;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseContentBlocks(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: ContentBlock[] = [];
  for (const valueBlock of value) {
    if (!isRecord(valueBlock) || typeof valueBlock.type !== 'string') continue;
    if (valueBlock.type === 'text' && typeof valueBlock.text === 'string') {
      blocks.push({ type: 'text', text: valueBlock.text });
      continue;
    }
    if (
      valueBlock.type === 'tool_use' &&
      typeof valueBlock.id === 'string' &&
      typeof valueBlock.name === 'string' &&
      isRecord(valueBlock.input)
    ) {
      blocks.push({
        type: 'tool_use',
        id: valueBlock.id,
        name: valueBlock.name,
        input: valueBlock.input,
      });
      continue;
    }
    if (valueBlock.type === 'tool_result' && typeof valueBlock.tool_use_id === 'string') {
      const content =
        typeof valueBlock.content === 'string'
          ? valueBlock.content
          : Array.isArray(valueBlock.content)
            ? valueBlock.content.filter(isRecord).map((part) => ({
                type: typeof part.type === 'string' ? part.type : undefined,
                text: typeof part.text === 'string' ? part.text : undefined,
              }))
            : undefined;
      blocks.push({
        type: 'tool_result',
        tool_use_id: valueBlock.tool_use_id,
        content,
        is_error: typeof valueBlock.is_error === 'boolean' ? valueBlock.is_error : undefined,
      });
    }
  }
  return blocks;
}

export async function parseTranscript(filePath: string): Promise<TranscriptMessage[]> {
  const messages: TranscriptMessage[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const raw = parsed as RawLine;

    // Skip compaction summaries
    if (raw.isCompactSummary) continue;

    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
    const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : undefined;

    // Tool result: attach to preceding assistant message
    if (isRecord(raw.toolUseResult)) {
      const toolResult: ToolResult = {
        toolUseId:
          typeof raw.toolUseResult.tool_use_id === 'string' ? raw.toolUseResult.tool_use_id : '',
        content: typeof raw.toolUseResult.content === 'string' ? raw.toolUseResult.content : '',
        isError:
          typeof raw.toolUseResult.is_error === 'boolean' ? raw.toolUseResult.is_error : undefined,
      };
      // Find last assistant message and attach
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].kind === 'assistant') {
          (messages[i] as AssistantMessage).toolResults.push(toolResult);
          break;
        }
      }
      continue;
    }

    if (!isRecord(raw.message)) continue;
    const role = raw.message.role;
    const rawContent = raw.message.content;
    const content = parseContentBlocks(rawContent);

    if (role === 'user') {
      if (content.length > 0) {
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const result = block as ToolResultContent;
          const content =
            typeof result.content === 'string'
              ? result.content
              : Array.isArray(result.content)
                ? result.content.map((part) => part.text ?? '').join('')
                : '';
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].kind === 'assistant') {
              (messages[i] as AssistantMessage).toolResults.push({
                toolUseId: result.tool_use_id,
                content,
                isError: result.is_error,
              });
              break;
            }
          }
        }
      }
      const text = extractText(typeof rawContent === 'string' ? rawContent : content);
      if (text) {
        messages.push({
          kind: 'user',
          sessionId,
          timestamp,
          text,
        });
      }
    } else if (role === 'assistant') {
      messages.push({
        kind: 'assistant',
        sessionId,
        timestamp,
        content,
        toolResults: [],
      });
    }
  }

  return messages;
}

function extractText(content: ContentBlock[] | string | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
