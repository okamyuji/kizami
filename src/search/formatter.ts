import * as path from 'node:path';
import type { ScoredResult } from './hybrid';

const MAX_CONTENT_LENGTH = 500;
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

  const header = '[Past Memory] 関連する過去の会話:\n';
  const entries = capped.map((r) => {
    const sessionShort = r.sessionId.slice(0, 6);
    const date = formatDate(r.createdAt);
    const score = r.score.toFixed(2);
    const content = truncate(r.content, MAX_CONTENT_LENGTH);
    const projectTag =
      r.isLocalProject === false ? ` [from: ${extractProjectName(r.projectPath)}]` : '';

    return `---\n[${date} ${sessionShort}]${projectTag} (relevance: ${score})\n${content}\n---`;
  });

  return header + '\n' + entries.join('\n\n') + '\n';
}
