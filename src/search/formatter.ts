import * as path from 'node:path';
import type { ScoredResult } from '@/search/hybrid';

const MAX_CONTENT_LENGTH = 360;
const DEFAULT_LIMIT = 10;

// 端末を操作する制御文字(ESC、BEL、OSC 52 など)、C1、表示順を入れ替える bidi 制御。改行とタブは含めない
export const TERMINAL_CONTROL =
  // eslint-disable-next-line no-control-regex -- 制御文字を見つけるのが目的
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function stripControlChars(text: string): string {
  return text.replace(TERMINAL_CONTROL, '');
}

/** JSON の文字列中の制御文字を \uXXXX にする。値は変わらない。JSON.stringify は U+0020 未満しかエスケープしない。 */
export function escapeControlChars(json: string): string {
  return json.replace(
    TERMINAL_CONTROL,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toISOString().slice(0, 10);
  } catch {
    return isoString;
  }
}

function extractProjectName(projectPath: string): string {
  return path.basename(projectPath);
}

export function formatResults(results: ScoredResult[], limit?: number): string {
  if (results.length === 0) {
    return '';
  }

  const capped = results.slice(0, limit ?? DEFAULT_LIMIT);

  const entries = capped.map((r) => {
    const sessionShort = r.sessionId.slice(0, 6);
    const date = formatDate(r.createdAt);
    const score = r.score.toFixed(2);
    const content = truncate(r.content, MAX_CONTENT_LENGTH);
    const projectTag =
      r.isLocalProject === false && r.projectPath
        ? ` from=${extractProjectName(r.projectPath)}`
        : '';

    return `[${date} ${sessionShort}${projectTag} s=${score}]\n${content}`;
  });

  return stripControlChars('[Mem]\n' + entries.join('\n---\n') + '\n');
}
