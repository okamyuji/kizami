import { createReadStream } from 'node:fs';

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

// 時計のずれは許すが、これを超えて未来の時刻は信じない。最新として固定され、保持期間の整理からも逃れるため。
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

// created_at は文字列のまま比べるので、UTC の ISO 形式以外はそろえる。この形式は書かれたまま残し、既存の鍵を変えない。
// Stryker disable next-line Regex: 前後に文字の付いた ISO 形式は Date.parse が NaN にするので、^ と $ を外しても結果は変わらない
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  // 解釈できない文字列は NaN になり、比較が false になって捨てられる
  if (!(ms <= Date.now() + MAX_FUTURE_SKEW_MS)) return undefined;
  return UTC_ISO_RE.test(value) ? value : new Date(ms).toISOString();
}

/**
 * ターンや会話の時刻。行の時刻が無ければ生ログの更新時刻を使い、行の時刻と同じ上限で切る。
 * 取り込み時刻を使うと古い会話が新しく見え、未来の更新時刻は最新として固定されるため。
 */
export function conversationTime(timestamp: string | undefined, mtime: Date): string {
  return (
    timestamp ?? new Date(Math.min(mtime.getTime(), Date.now() + MAX_FUTURE_SKEW_MS)).toISOString()
  );
}

/** 1 行を解釈して messages に足す。ツール結果は直前の assistant に付ける。 */
function appendLine(messages: TranscriptMessage[], line: string): void {
  // JSON.parse は BOM と NBSP を空白として扱わないので、先に trim で落とす。
  const trimmed = line.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 空行と壊れた行は parsed が undefined のまま、次の isRecord で読み飛ばす。
  }
  if (!isRecord(parsed)) return;
  const raw = parsed as RawLine;

  // Skip compaction summaries
  if (raw.isCompactSummary) return;

  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
  const timestamp = validTimestamp(raw.timestamp);

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
    return;
  }

  if (!isRecord(raw.message)) return;
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

export function parseTranscriptText(text: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const line of text.split(/\r?\n/)) appendLine(messages, line);
  return messages;
}

/**
 * 行を \n だけで区切る(行末の \r は JSON.parse が空白として読み飛ばす)。readline は U+2028/U+2029 でも区切り、
 * JSON 文字列中の生の U+2028 で行が割れて捨てられるため。呼び出し側が途中で抜けるとストリームも閉じる。
 */
export async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  let rest = '';
  for await (const chunk of createReadStream(filePath, { encoding: 'utf-8' })) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() as string;
    yield* lines;
  }
  yield rest;
}

export async function parseTranscript(filePath: string): Promise<TranscriptMessage[]> {
  const messages: TranscriptMessage[] = [];
  for await (const line of readJsonlLines(filePath)) appendLine(messages, line);
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
