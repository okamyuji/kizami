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

export type ContentBlock = TextContent | ToolUseContent;

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
  };
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

    let raw: RawLine;
    try {
      raw = JSON.parse(trimmed) as RawLine;
    } catch {
      continue;
    }

    // Skip compaction summaries
    if (raw.isCompactSummary) continue;

    const sessionId = raw.sessionId ?? '';

    // Tool result: attach to preceding assistant message
    if (raw.toolUseResult) {
      const toolResult: ToolResult = {
        toolUseId: raw.toolUseResult.tool_use_id ?? '',
        content: typeof raw.toolUseResult.content === 'string' ? raw.toolUseResult.content : '',
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

    if (!raw.message) continue;

    if (raw.message.role === 'user') {
      const text = extractText(raw.message.content);
      if (text) {
        messages.push({
          kind: 'user',
          sessionId,
          timestamp: raw.timestamp,
          text,
        });
      }
    } else if (raw.message.role === 'assistant') {
      const content = Array.isArray(raw.message.content) ? raw.message.content : [];
      messages.push({
        kind: 'assistant',
        sessionId,
        timestamp: raw.timestamp,
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
