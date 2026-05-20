import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

/**
 * JSONL正本のファイル名規約: {YYYY}-{MM}-{hostname}.jsonl
 *
 * 月単位 + ホスト単位で分割することで、複数マシン間のGit同期時の
 * マージ衝突を最小化する。ホスト名は os.hostname() の最初の "." 以前を
 * sanitize したものを使う（FQDN差異の影響を避ける）。
 */
export function getHostnameSegment(): string {
  const raw = os.hostname() || 'unknown';
  const short = raw.split('.')[0] ?? raw;
  // ファイル名に使えない文字を "-" に置換
  return short.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase() || 'unknown';
}

export function getMonthSegment(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function getJsonlFilename(date: Date = new Date(), hostname?: string): string {
  const host = hostname ?? getHostnameSegment();
  return `${getMonthSegment(date)}-${host}.jsonl`;
}

export function getJsonlFilePath(jsonlDir: string, date: Date = new Date()): string {
  return path.join(jsonlDir, getJsonlFilename(date));
}

export function ensureJsonlDir(jsonlDir: string): void {
  if (!fs.existsSync(jsonlDir)) {
    fs.mkdirSync(jsonlDir, { recursive: true });
  }
}

/**
 * JSONLディレクトリ内の全ファイルを月順（古い→新しい）で返す。
 * ファイル名のYYYY-MM部分でソートするので、ホスト単位の入れ子順序は影響しない。
 */
export function listJsonlFiles(jsonlDir: string): string[] {
  if (!fs.existsSync(jsonlDir)) return [];
  return fs
    .readdirSync(jsonlDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => path.join(jsonlDir, f));
}
