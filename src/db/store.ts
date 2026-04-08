import type Database from 'better-sqlite3';

export interface Chunk {
  id?: number;
  sessionId: string;
  projectPath: string;
  chunkIndex: number;
  content: string;
  role: 'human' | 'assistant' | 'mixed';
  metadata: {
    filePaths: string[];
    toolNames: string[];
    errorMessages: string[];
  };
  createdAt?: string;
  tokenCount: number;
}

export interface Session {
  sessionId: string;
  projectPath: string;
  startedAt?: string;
  endedAt?: string;
  chunkCount?: number;
  firstMessage?: string;
  lastMessage?: string;
}

export interface SearchResult {
  id: number;
  content: string;
  sessionId: string;
  projectPath: string;
  createdAt: string;
  metadata: string | null;
  rank?: number;
}

export interface StoreStats {
  totalChunks: number;
  totalSessions: number;
  dbSizeBytes: number;
}

export class Store {
  constructor(private db: Database.Database) {}

  insertChunks(chunks: Chunk[]): void {
    const insert = this.db.prepare(`
      INSERT INTO chunks (session_id, project_path, chunk_index, content, role, metadata, token_count)
      VALUES (@sessionId, @projectPath, @chunkIndex, @content, @role, @metadata, @tokenCount)
    `);

    const tx = this.db.transaction((items: Chunk[]) => {
      for (const chunk of items) {
        insert.run({
          sessionId: chunk.sessionId,
          projectPath: chunk.projectPath,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          role: chunk.role,
          metadata: JSON.stringify(chunk.metadata),
          tokenCount: chunk.tokenCount,
        });
      }
    });

    tx(chunks);
  }

  insertSession(session: Session): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO sessions (session_id, project_path, started_at, ended_at, chunk_count, first_message, last_message)
      VALUES (@sessionId, @projectPath, @startedAt, @endedAt, @chunkCount, @firstMessage, @lastMessage)
    `
      )
      .run({
        sessionId: session.sessionId,
        projectPath: session.projectPath,
        startedAt: session.startedAt ?? null,
        endedAt: session.endedAt ?? new Date().toISOString(),
        chunkCount: session.chunkCount ?? 0,
        firstMessage: session.firstMessage ?? null,
        lastMessage: session.lastMessage ?? null,
      });
  }

  getChunk(id: number): Chunk | undefined {
    const row = this.db
      .prepare(
        `
      SELECT id, session_id, project_path, chunk_index, content, role, metadata, created_at, token_count
      FROM chunks WHERE id = ?
    `
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return this.rowToChunk(row);
  }

  updateChunkContent(id: number, content: string): void {
    this.db.prepare('UPDATE chunks SET content = ? WHERE id = ?').run(content, id);
  }

  deleteChunk(id: number): void {
    this.db.prepare('DELETE FROM chunks WHERE id = ?').run(id);
  }

  deleteSession(sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunks WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    });
    tx();
  }

  deleteChunksBefore(date: string): number {
    const result = this.db.prepare('DELETE FROM chunks WHERE created_at < ?').run(date);
    return result.changes;
  }

  searchFTS(query: string, projectPath: string, limit: number): SearchResult[] {
    return this.db
      .prepare(
        `
      SELECT c.id, c.content, c.session_id AS sessionId, c.project_path AS projectPath,
             c.created_at AS createdAt, c.metadata, rank
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
      WHERE chunks_fts MATCH ?
        AND c.project_path = ?
      ORDER BY f.rank
      LIMIT ?
    `
      )
      .all(query, projectPath, limit) as SearchResult[];
  }

  searchFTSAll(query: string, limit: number): SearchResult[] {
    return this.db
      .prepare(
        `
      SELECT c.id, c.content, c.session_id AS sessionId, c.project_path AS projectPath,
             c.created_at AS createdAt, c.metadata, rank
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY f.rank
      LIMIT ?
    `
      )
      .all(query, limit) as SearchResult[];
  }

  searchLike(query: string, projectPath: string, limit: number): SearchResult[] {
    return this.db
      .prepare(
        `
      SELECT c.id, c.content, c.session_id AS sessionId, c.project_path AS projectPath,
             c.created_at AS createdAt, c.metadata
      FROM chunks c
      WHERE c.content LIKE ?
        AND c.project_path = ?
      ORDER BY c.created_at DESC
      LIMIT ?
    `
      )
      .all(`%${query}%`, projectPath, limit) as SearchResult[];
  }

  searchLikeAll(query: string, limit: number): SearchResult[] {
    return this.db
      .prepare(
        `
      SELECT c.id, c.content, c.session_id AS sessionId, c.project_path AS projectPath,
             c.created_at AS createdAt, c.metadata
      FROM chunks c
      WHERE c.content LIKE ?
      ORDER BY c.created_at DESC
      LIMIT ?
    `
      )
      .all(`%${query}%`, limit) as SearchResult[];
  }

  getSessionList(projectPath?: string): Session[] {
    if (projectPath) {
      return (
        this.db
          .prepare(
            `
        SELECT session_id, project_path, started_at, ended_at, chunk_count, first_message, last_message
        FROM sessions WHERE project_path = ? ORDER BY ended_at DESC
      `
          )
          .all(projectPath) as Record<string, unknown>[]
      ).map(this.rowToSession);
    }
    return (
      this.db
        .prepare(
          `
      SELECT session_id, project_path, started_at, ended_at, chunk_count, first_message, last_message
      FROM sessions ORDER BY ended_at DESC
    `
        )
        .all() as Record<string, unknown>[]
    ).map(this.rowToSession);
  }

  getStats(): StoreStats {
    const chunksRow = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
      count: number;
    };
    const sessionsRow = this.db.prepare('SELECT COUNT(*) as count FROM sessions').get() as {
      count: number;
    };
    const sizeRow = this.db
      .prepare(
        `SELECT (page_count - freelist_count) * page_size as size
         FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()`
      )
      .get() as {
      size: number;
    };

    return {
      totalChunks: chunksRow.count,
      totalSessions: sessionsRow.count,
      dbSizeBytes: sizeRow?.size ?? 0,
    };
  }

  insertEmbedding(chunkId: number, embedding: Float32Array): void {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const info = this.db.prepare('INSERT INTO chunks_vec (embedding) VALUES (?)').run(buf);
    this.db
      .prepare('INSERT OR REPLACE INTO chunks_vec_map (chunk_id, vec_rowid) VALUES (?, ?)')
      .run(chunkId, info.lastInsertRowid);
  }

  searchVec(queryEmbedding: Float32Array, projectPath: string, limit: number): SearchResult[] {
    const buf = Buffer.from(
      queryEmbedding.buffer,
      queryEmbedding.byteOffset,
      queryEmbedding.byteLength
    );
    return this.db
      .prepare(
        `SELECT c.id, c.content, c.session_id AS sessionId, c.project_path AS projectPath,
                c.created_at AS createdAt, c.metadata, v.distance AS rank
         FROM chunks_vec v
         JOIN chunks_vec_map m ON m.vec_rowid = v.rowid
         JOIN chunks c ON c.id = m.chunk_id
         WHERE v.embedding MATCH ?
           AND k = ?
           AND c.project_path = ?
         ORDER BY v.distance
         LIMIT ?`
      )
      .all(buf, limit, projectPath, limit) as SearchResult[];
  }

  searchVecAll(queryEmbedding: Float32Array, limit: number): SearchResult[] {
    const buf = Buffer.from(
      queryEmbedding.buffer,
      queryEmbedding.byteOffset,
      queryEmbedding.byteLength
    );
    return this.db
      .prepare(
        `SELECT c.id, c.content, c.session_id AS sessionId, c.project_path AS projectPath,
                c.created_at AS createdAt, c.metadata, v.distance AS rank
         FROM chunks_vec v
         JOIN chunks_vec_map m ON m.vec_rowid = v.rowid
         JOIN chunks c ON c.id = m.chunk_id
         WHERE v.embedding MATCH ?
           AND k = ?
         ORDER BY v.distance
         LIMIT ?`
      )
      .all(buf, limit, limit) as SearchResult[];
  }

  hasVecTable(): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_vec'")
      .get();
    return !!row;
  }

  hasSession(sessionId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM sessions WHERE session_id = ? LIMIT 1')
      .get(sessionId);
    return !!row;
  }

  getChunkIdsWithoutEmbedding(): number[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT c.id FROM chunks c
           LEFT JOIN chunks_vec_map m ON c.id = m.chunk_id
           WHERE m.chunk_id IS NULL`
        )
        .all() as { id: number }[];
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
  }

  getLastMaintenanceTime(): string | null {
    try {
      const row = this.db
        .prepare('SELECT executed_at FROM maintenance_log ORDER BY executed_at DESC LIMIT 1')
        .get() as { executed_at: string } | undefined;
      return row?.executed_at ?? null;
    } catch {
      return null;
    }
  }

  logMaintenance(action: string, chunksDeleted: number, bytesFreed: number): void {
    this.db
      .prepare('INSERT INTO maintenance_log (action, chunks_deleted, bytes_freed) VALUES (?, ?, ?)')
      .run(action, chunksDeleted, bytesFreed);
  }

  vacuum(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  deleteOldestChunks(count: number): number {
    const result = this.db
      .prepare(
        'DELETE FROM chunks WHERE id IN (SELECT id FROM chunks ORDER BY created_at ASC, id ASC LIMIT ?)'
      )
      .run(count);
    return result.changes;
  }

  deleteOrphanedSessions(): number {
    const result = this.db
      .prepare(
        'DELETE FROM sessions WHERE session_id NOT IN (SELECT DISTINCT session_id FROM chunks)'
      )
      .run();
    return result.changes;
  }

  private rowToChunk(row: Record<string, unknown>): Chunk {
    let metadata: Chunk['metadata'];
    try {
      metadata = JSON.parse(row['metadata'] as string);
    } catch {
      metadata = { filePaths: [], toolNames: [], errorMessages: [] };
    }

    return {
      id: row['id'] as number,
      sessionId: row['session_id'] as string,
      projectPath: row['project_path'] as string,
      chunkIndex: row['chunk_index'] as number,
      content: row['content'] as string,
      role: row['role'] as 'human' | 'assistant' | 'mixed',
      metadata,
      createdAt: row['created_at'] as string,
      tokenCount: row['token_count'] as number,
    };
  }

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      sessionId: row['session_id'] as string,
      projectPath: row['project_path'] as string,
      startedAt: row['started_at'] as string | undefined,
      endedAt: row['ended_at'] as string | undefined,
      chunkCount: row['chunk_count'] as number | undefined,
      firstMessage: row['first_message'] as string | undefined,
      lastMessage: row['last_message'] as string | undefined,
    };
  }
}
