import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTranscriptText } from '@/parser/transcript';
import { buildTurns, turnToText } from '@/parser/chunker';
import { redactTurnText } from '@/archive/deletions';

export interface ArchiveHit {
  sessionId: string;
  dirName: string;
  mtime: Date;
  snippet: string;
}

const SNIPPET_CHARS = 300;

// Stryker disable BlockStatement: catch を空にしても undefined が返り、呼び出し側の ?. が同じく読み飛ばすため区別できない
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined; // 壊れた行は生のまま扱う
  }
}
// Stryker restore BlockStatement

function messageText(line: string): string | undefined {
  const content = (parseLine(line) as { message?: { content?: unknown } } | null | undefined)
    ?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
  }
  return undefined;
}

function snippetFor(raw: string, term: string): string {
  const lines = raw.split('\n');
  for (const line of lines) {
    const text = messageText(line);
    if (text && text.toLowerCase().includes(term)) return text.slice(0, SNIPPET_CHARS);
  }
  // 呼び出し側が全 term の存在を確認済みなので、生の行は必ず見つかる。
  const hit = lines.find((l) => l.toLowerCase().includes(term)) as string;
  return hit.slice(0, SNIPPET_CHARS);
}

const SNIPPET_LEAD_CHARS = 100;

/** 削除したチャンクに語があっても当たらないよう、伏せた本文で照合し直す。 */
function keptSnippet(raw: string, terms: string[], deleted: Set<string>): string | undefined {
  const text = buildTurns(parseTranscriptText(raw))
    .map((turn) => redactTurnText(turnToText(turn), deleted))
    .join('\n\n');
  const lower = text.toLowerCase();
  if (!terms.every((t) => lower.includes(t))) return undefined;
  const start = Math.max(0, lower.indexOf(terms[0]) - SNIPPET_LEAD_CHARS);
  return text.slice(start, start + SNIPPET_CHARS);
}

/**
 * FTS のチャンクは maintenance で消える。消えた期間のセッションだけを生ログから探す。
 * ponytail: 1 回の検索で対象ファイルを全文読む。保管が数 GB を超えて遅くなったら索引を作る。
 */
export function scanArchive(
  query: string,
  archiveDir: string,
  olderThanMs: number,
  now = Date.now(),
  limit = 10,
  deletedSessions: Set<string> = new Set(),
  deletedChunkDigests: Set<string> = new Set()
): ArchiveHit[] {
  if (!query.trim()) return [];
  const terms = query.toLowerCase().match(/\S+/g) as string[];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: ArchiveHit[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(archiveDir, dir.name))) {
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (!name.endsWith('.jsonl') || deletedSessions.has(sessionId)) continue;
      const file = path.join(archiveDir, dir.name, name);
      const { mtimeMs } = fs.statSync(file);
      if (now - mtimeMs <= olderThanMs) continue;
      const raw = fs.readFileSync(file, 'utf-8');
      const lower = raw.toLowerCase();
      if (!terms.every((t) => lower.includes(t))) continue;
      const snippet =
        deletedChunkDigests.size === 0
          ? snippetFor(raw, terms[0])
          : keptSnippet(raw, terms, deletedChunkDigests);
      if (snippet === undefined) continue;
      hits.push({ sessionId, dirName: dir.name, mtime: new Date(mtimeMs), snippet });
    }
  }
  return hits.sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, limit);
}

export function formatArchiveHits(hits: ArchiveHit[]): string {
  return hits
    .map(
      (h) =>
        `[${h.mtime.toISOString().slice(0, 10)} ${h.sessionId.slice(0, 6)} from=${h.dirName} archived]\n${h.snippet}\n`
    )
    .join('---\n');
}
