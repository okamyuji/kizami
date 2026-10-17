import Database from 'better-sqlite3';
import * as path from 'node:path';
import { getDefaultDbPath } from '@/config';
import {
  assertPrivateFileTarget,
  enforcePrivateDirectory,
  restrictSqliteFile,
} from '@/storage/permissions';

export function getDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || getDefaultDbPath();

  // Create parent directories if needed
  const dir = path.dirname(resolvedPath);
  enforcePrivateDirectory(dir);
  assertPrivateFileTarget(resolvedPath);
  assertPrivateFileTarget(`${resolvedPath}-wal`);
  assertPrivateFileTarget(`${resolvedPath}-shm`);

  const db = new Database(resolvedPath);
  try {
    // Set WAL mode for better concurrent access
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    // 消した行の本文がファイルの空きページに残らないよう、ページを 0 で埋める（会話の写しや手で消した秘密）
    db.pragma('secure_delete = ON');

    restrictSqliteFile(resolvedPath);
    restrictSqliteFile(`${resolvedPath}-wal`);
    restrictSqliteFile(`${resolvedPath}-shm`);
  } catch (error: unknown) {
    db.close();
    throw error;
  }

  return db;
}
