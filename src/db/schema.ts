import type Database from 'better-sqlite3';

const CURRENT_SCHEMA_VERSION = 1;

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

export function initializeSchema(db: Database.Database): void {
  const currentVersion = getSchemaVersion(db);

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return;
  }

  db.transaction(() => {
    if (currentVersion < 1) {
      db.exec(SCHEMA_V1);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
    }
  })();
}
