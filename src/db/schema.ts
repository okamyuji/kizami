import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const CURRENT_SCHEMA_VERSION = 4;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('human', 'assistant', 'mixed')),
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  token_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_path);
CREATE INDEX IF NOT EXISTS idx_chunks_created ON chunks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content=chunks,
  content_rowid=id,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content)
    VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF content ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content)
    VALUES('delete', old.id, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT NOT NULL DEFAULT (datetime('now')),
  chunk_count INTEGER DEFAULT 0,
  first_message TEXT,
  last_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS maintenance_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  chunks_deleted INTEGER NOT NULL DEFAULT 0,
  bytes_freed INTEGER NOT NULL DEFAULT 0,
  executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// v0.2.0: JSONL正本化のため、chunks に external_id を追加。
// JSONL の各レコード id (crypto.randomUUID) を SQLite 側にも保持することで、
// self-healing 時の存在チェック・rebuild 時の冪等性を担保する。
// SQLite では NULL同士は distinct 扱いになるので、UNIQUEインデックスでも
// 既存の NULL 行と新規 NULL 行は共存できる。
const SCHEMA_V3 = `
ALTER TABLE chunks ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_external_id ON chunks(external_id)
  WHERE external_id IS NOT NULL;
`;

const SCHEMA_V4 = `
-- Table-copy migration to add v2 checkpoint columns and remove UNIQUE(session_id, chunk_index)
CREATE TABLE chunks_v4 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  session_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('human', 'assistant', 'mixed')),
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  token_count INTEGER NOT NULL DEFAULT 0,
  turn_key TEXT,
  source_order TEXT,
  part_index INTEGER,
  revision INTEGER,
  content_hash TEXT,
  observed_through TEXT,
  history_epoch INTEGER
);

INSERT INTO chunks_v4 (id, external_id, session_id, project_path, chunk_index, content, role, metadata, created_at, token_count)
  SELECT id, external_id, session_id, project_path, chunk_index, content, role, metadata, created_at, token_count FROM chunks;

DROP TABLE chunks;
ALTER TABLE chunks_v4 RENAME TO chunks;

-- Restore sqlite_sequence for AUTOINCREMENT continuity
DELETE FROM sqlite_sequence WHERE name = 'chunks_v4';

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_path);
CREATE INDEX IF NOT EXISTS idx_chunks_created ON chunks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_external_id ON chunks(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_turn ON chunks(session_id, turn_key, part_index);

-- Recreate FTS
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content=chunks,
  content_rowid=id,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content)
    VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF content ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content)
    VALUES('delete', old.id, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Rebuild FTS index
INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
`;

function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

export function initializeHybridSchema(db: Database.Database, dimensions: number): void {
  try {
    const esmRequire = createRequire(import.meta.url);
    const sqliteVec = esmRequire('sqlite-vec') as { load: (db: Database.Database) => void };
    sqliteVec.load(db);

    // chunks_vecが既に存在するかチェック
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_vec'")
      .get();
    if (!exists) {
      db.exec(`CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[${dimensions}])`);
      db.exec(
        `CREATE TABLE IF NOT EXISTS chunks_vec_map (chunk_id INTEGER PRIMARY KEY, vec_rowid INTEGER NOT NULL)`
      );
    }
  } catch (err) {
    // sqlite-vecが利用できない場合はスキップ
    throw new Error(`sqlite-vec initialization failed: ${String(err)}`);
  }
}

export function initializeSchema(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db);

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return;
  }

  db.transaction(() => {
    if (currentVersion < 1) {
      db.exec(SCHEMA_V1);
    }
    if (currentVersion < 2) {
      db.exec(SCHEMA_V2);
    }
    if (currentVersion < 3) {
      db.exec(SCHEMA_V3);
    }
    if (currentVersion < 4) {
      // Drop FTS triggers before table copy
      db.exec('DROP TRIGGER IF EXISTS chunks_ai');
      db.exec('DROP TRIGGER IF EXISTS chunks_ad');
      db.exec('DROP TRIGGER IF EXISTS chunks_au');
      db.exec('DROP TABLE IF EXISTS chunks_fts');

      // Load sqlite-vec if vector table exists (preserve vec_map references)
      const hasVec = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_vec'")
        .get();
      if (hasVec) {
        try {
          const esmRequire = createRequire(import.meta.url);
          const sqliteVec = esmRequire('sqlite-vec') as {
            load: (db: Database.Database) => void;
          };
          sqliteVec.load(db);
        } catch {
          // sqlite-vec unavailable; vec_map FK references still safe since IDs are preserved
        }
      }

      db.exec(SCHEMA_V4);
    }
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(
      CURRENT_SCHEMA_VERSION
    );
  })();
}
