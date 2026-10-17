import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { splitTurnText } from '@/parser/chunker';
import type { EngramConfig } from '@/config';
import type { Chunk, Store } from '@/db/store';
import { appendChunkDeletion } from '@/jsonl/deletion';

export interface Deletions {
  sessions: Set<string>;
  chunkDigests: Set<string>;
  /** 手でチャンクを消したセッション。生ログから作り直すと、消した本文が別の形で戻る。 */
  chunkSessions: Set<string>;
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
  if (!fs.existsSync(file)) {
    return { sessions: new Set(), chunkDigests: new Set(), chunkSessions: new Set() };
  }
  let raw: { sessions?: unknown; chunkDigests?: unknown; chunkSessions?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as typeof raw;
  } catch (err) {
    throw new Error(`Cannot read deletion list ${file}: ${String(err)}`, { cause: err });
  }
  return {
    sessions: new Set(strings(raw.sessions)),
    chunkDigests: new Set(strings(raw.chunkDigests)),
    chunkSessions: new Set(strings(raw.chunkSessions)),
  };
}

function save(file: string, d: Deletions): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    sessions: [...d.sessions],
    chunkDigests: [...d.chunkDigests],
    chunkSessions: [...d.chunkSessions],
  };
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

export function recordChunkDeletion(file: string, content: string, sessionId?: string): void {
  const d = loadDeletions(file);
  d.chunkDigests.add(contentDigest(content));
  if (sessionId !== undefined) d.chunkSessions.add(sessionId);
  save(file, d);
}

/** 正本に chunk_delete を持つセッションを書き足す。記録を持たない版で消したものを拾うため。 */
export function recordChunkSessions(file: string, sessionIds: Set<string>): void {
  const d = loadDeletions(file);
  if ([...sessionIds].every((id) => d.chunkSessions.has(id))) return;
  for (const id of sessionIds) d.chunkSessions.add(id);
  save(file, d);
}

/**
 * チャンクを JSONL 正本、DB、削除の記録から消す。正本を先に書き、失敗したら何も消さない。
 * external id の無い古いチャンクは正本に記録できないので false を返す。
 */
export function deleteChunkEverywhere(
  store: Store,
  config: EngramConfig,
  chunk: Chunk & { id: number }
): boolean {
  if (chunk.externalId) {
    appendChunkDeletion(config.storage.jsonlDir, chunk.sessionId, chunk.externalId);
  }
  store.deleteChunk(chunk.id);
  recordChunkDeletion(deletionsFile(config.database.path), chunk.content, chunk.sessionId);
  return chunk.externalId !== undefined;
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
