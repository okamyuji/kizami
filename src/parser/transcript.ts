import { readLines } from '@/storage/lines';

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

function parseRawLine(line: string): RawLine | undefined {
  // JSON.parse は BOM と NBSP を空白として扱わないので、先に trim で落とす。
  const trimmed = line.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 空行と壊れた行は parsed が undefined のまま、次の isRecord で読み飛ばす。
  }
  return isRecord(parsed) ? (parsed as RawLine) : undefined;
}

function attachToLastAssistant(messages: TranscriptMessage[], toolResult: ToolResult): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'assistant') {
      (messages[i] as AssistantMessage).toolResults.push(toolResult);
      return;
    }
  }
}

function fromToolUseResult(result: NonNullable<RawLine['toolUseResult']>): ToolResult {
  return {
    toolUseId: typeof result.tool_use_id === 'string' ? result.tool_use_id : '',
    content: typeof result.content === 'string' ? result.content : '',
    isError: typeof result.is_error === 'boolean' ? result.is_error : undefined,
  };
}

function toolResultText(content: ToolResultContent['content']): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '';
}

function appendUser(
  messages: TranscriptMessage[],
  rawContent: ContentBlock[] | string | undefined,
  sessionId: string,
  timestamp: string | undefined
): void {
  const content = parseContentBlocks(rawContent);
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    attachToLastAssistant(messages, {
      toolUseId: block.tool_use_id,
      content: toolResultText(block.content),
      isError: block.is_error,
    });
  }
  const text = extractText(typeof rawContent === 'string' ? rawContent : content);
  if (text) messages.push({ kind: 'user', sessionId, timestamp, text });
}

export interface ParseOptions {
  /** 0.8.5 以前の読み方。api-request-blob 行も発言として読む。その版で消したチャンクと照合するためだけに使う。 */
  requestCopies?: boolean;
}

/** 1 行を解釈して messages に足す。ツール結果は直前の assistant に付ける。 */
function appendLine(messages: TranscriptMessage[], line: string, options: ParseOptions): void {
  const raw = parseRawLine(line);
  // Skip compaction summaries
  if (!raw || raw.isCompactSummary) return;

  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
  const timestamp = validTimestamp(raw.timestamp);

  if (isRecord(raw.toolUseResult)) {
    attachToLastAssistant(messages, fromToolUseResult(raw.toolUseResult));
    return;
  }

  // api-request-blob 行も message.role を持つが、API へ送った本文（system-reminder を含む）の写しで会話ではない
  const conversation = raw.type === 'user' || raw.type === 'assistant';
  if (!conversation && !(options.requestCopies && raw.type === 'api-request-blob')) return;
  if (!isRecord(raw.message)) return;
  const { role, content } = raw.message;
  if (role === 'user') {
    appendUser(messages, content, sessionId, timestamp);
  } else if (role === 'assistant') {
    messages.push({
      kind: 'assistant',
      sessionId,
      timestamp,
      content: parseContentBlocks(content),
      toolResults: [],
    });
  }
}

export function parseTranscriptText(text: string, options: ParseOptions = {}): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const line of text.split(/\r?\n/)) appendLine(messages, line, options);
  return messages;
}

export async function parseTranscript(
  filePath: string,
  options: ParseOptions = {}
): Promise<TranscriptMessage[]> {
  const messages: TranscriptMessage[] = [];
  for await (const line of readLines(filePath)) appendLine(messages, line, options);
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
