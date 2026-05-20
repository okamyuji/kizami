import type { Store } from '@/db/store';
import { listJsonlFiles } from '@/jsonl/path';
import { readTailRecords } from '@/jsonl/reader';
import { jsonlRecordToChunk } from '@/jsonl/converter';

export interface SelfHealResult {
  scanned: number;
  reinserted: number;
}

/**
 * 直近のJSONLファイル末尾N行をスキャンし、SQLite に存在しないレコードを補完する。
 * フェイルファスト方針により通常は不整合が起きないが、SQLite挿入だけが失敗した場合に
 * 次回 save 時に検出して自動補完するための保険機構。
 *
 * 計測: 100行スキャンは数msオーダーで完了する見込み（設計書 §5.1）。
 */
export function selfHealFromJsonl(
  store: Store,
  jsonlDir: string,
  tailLines: number = 100
): SelfHealResult {
  const files = listJsonlFiles(jsonlDir);
  if (files.length === 0) return { scanned: 0, reinserted: 0 };

  // 最新月のファイルだけを対象にする（古い月の不整合は手動 rebuild で対処）
  const latest = files[files.length - 1];
  const records = readTailRecords(latest, tailLines);
  if (records.length === 0) return { scanned: 0, reinserted: 0 };

  const externalIds = records.map((r) => r.id);
  const missing = new Set(store.findMissingExternalIds(externalIds));
  if (missing.size === 0) return { scanned: records.length, reinserted: 0 };

  const toInsert = records.filter((r) => missing.has(r.id)).map(jsonlRecordToChunk);
  const inserted = store.appendChunksWithoutReplace(toInsert);

  return { scanned: records.length, reinserted: inserted };
}
