import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { splitTurnText } from '@/parser/chunker';

export interface Deletions {
  sessions: Set<string>;
  chunkDigests: Set<string>;
}

const DELETED_MARK = '[deleted]';

export function deletionsFile(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'deletions.json');
}

/** 削除したチャンクの本文は残せないので、照合には内容のダイジェストだけを持つ。 */
export function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function loadDeletions(file: string): Deletions {
  if (!fs.existsSync(file)) return { sessions: new Set(), chunkDigests: new Set() };
  let raw: { sessions?: unknown; chunkDigests?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as typeof raw;
  } catch (err) {
    throw new Error(`Cannot read deletion list ${file}: ${String(err)}`, { cause: err });
  }
  return {
    sessions: new Set(strings(raw.sessions)),
    chunkDigests: new Set(strings(raw.chunkDigests)),
  };
}

function save(file: string, d: Deletions): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { sessions: [...d.sessions], chunkDigests: [...d.chunkDigests] };
  // 途中で切れたファイルは loadDeletions が拒むので、書き終えてから置き換える。
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function recordSessionDeletion(file: string, sessionId: string): void {
  const d = loadDeletions(file);
  d.sessions.add(sessionId);
  save(file, d);
}

export function recordChunkDeletion(file: string, content: string): void {
  const d = loadDeletions(file);
  d.chunkDigests.add(contentDigest(content));
  save(file, d);
}

/**
 * チャンクは turnToText の結果を splitTurnText(…, 512) で分けたもの。同じ分け方で
 * 部品に戻し、削除済みの部品だけを伏せる。
 */
export function redactTurnText(text: string, chunkDigests: Set<string>): string {
  // Stryker disable next-line ConditionalExpression: 削除が無いときに分割を省く近道。外しても次の行が同じ text を返す
  if (chunkDigests.size === 0) return text;
  const parts = splitTurnText(text, 512);
  if (!parts.some((p) => chunkDigests.has(contentDigest(p)))) return text;
  return parts.map((p) => (chunkDigests.has(contentDigest(p)) ? DELETED_MARK : p)).join('\n\n');
}
