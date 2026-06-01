import * as path from 'node:path';
import type { ScoredResult } from '@/search/hybrid';

const MAX_CONTENT_LENGTH = 360;
const DEFAULT_LIMIT = 10;

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

  return '[Mem]\n' + entries.join('\n---\n') + '\n';
}
