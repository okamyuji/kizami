import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDefaultDbPath } from '@/config';

export function getDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || getDefaultDbPath();

  // Create parent directories if needed
  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(resolvedPath);

  // Set WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Set file permissions to 0600 (owner read/write only)
  try {
    fs.chmodSync(resolvedPath, 0o600);
  } catch {
    // May fail on some platforms, non-critical
  }

  return db;
}
