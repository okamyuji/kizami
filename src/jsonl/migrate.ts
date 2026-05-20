import { randomUUID } from 'node:crypto';
import type { EngramConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { JsonlWriter } from '@/jsonl/writer';
import type { JsonlChunkRecord } from '@/jsonl/types';

export interface MigrateResult {
  totalChunks: number;
  exported: number;
  alreadyMigrated: number;
}

/**
 * 既存 SQLite (v0.1.x ユーザー) のチャンク全件を JSONL にダンプする。
 *
 * - external_id が未付与の行には新規 UUID を発行し SQLite 側にも書き戻す
 *   （これにより以降の self-healing と rebuild が動作可能になる）
 * - 既に external_id を持つ行は既存 ID を維持
 * - 既に同じ external_id が JSONL に書かれている可能性は無視（重複は append 容認、
 *   rebuild 時に最新行が優先される）
 */
export function migrateSqliteToJsonl(config: EngramConfig): MigrateResult {
  const db = getDatabase(config.database.path);
  try {
    initializeSchema(db);
    const store = new Store(db);

    const rows = db
      .prepare(
        `SELECT id, external_id, session_id, project_path, chunk_index, content, role,
                metadata, token_count, created_at
         FROM chunks ORDER BY created_at ASC, id ASC`
      )
      .all() as {
      id: number;
      external_id: string | null;
      session_id: string;
      project_path: string;
      chunk_index: number;
      content: string;
      role: 'human' | 'assistant' | 'mixed';
      metadata: string | null;
      token_count: number;
      created_at: string;
    }[];

    const writer = new JsonlWriter(config.storage.jsonlDir);
    const assignExternalId = db.prepare('UPDATE chunks SET external_id = ? WHERE id = ?');

    let exported = 0;
    let alreadyMigrated = 0;
    const tx = db.transaction(() => {
      // 月ごとにまとめて書き出す（書き込みの atomicity を高める）
      const byMonth = new Map<string, JsonlChunkRecord[]>();
      for (const row of rows) {
        if (row.external_id) {
          alreadyMigrated++;
        }
        const externalId = row.external_id ?? randomUUID();
        if (!row.external_id) {
          assignExternalId.run(externalId, row.id);
        }
        const createdAtDate = new Date(row.created_at);
        const monthKey = `${createdAtDate.getUTCFullYear()}-${String(createdAtDate.getUTCMonth() + 1).padStart(2, '0')}`;
        const rec: JsonlChunkRecord = {
          v: 1,
          type: 'chunk',
          id: externalId,
          sessionId: row.session_id,
          projectPath: row.project_path,
          chunkIndex: row.chunk_index,
          content: row.content,
          role: row.role,
          metadata: row.metadata,
          tokenCount: row.token_count,
          createdAt: row.created_at,
        };
        const arr = byMonth.get(monthKey) ?? [];
        arr.push(rec);
        byMonth.set(monthKey, arr);
        exported++;
      }
      for (const [monthKey, recs] of byMonth) {
        const [y, m] = monthKey.split('-').map((s) => parseInt(s, 10));
        const date = new Date(Date.UTC(y, m - 1, 1));
        writer.appendRecords(recs, date);
      }
    });
    tx();

    void store; // currently unused but kept for symmetric API
    return { totalChunks: rows.length, exported, alreadyMigrated };
  } finally {
    db.close();
  }
}
