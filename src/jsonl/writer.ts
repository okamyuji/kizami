import * as fs from 'node:fs';
import { ensureJsonlDir, getJsonlFilePath } from '@/jsonl/path';
import type { JsonlChunkRecord } from '@/jsonl/types';

/**
 * 単一の月ファイルに対する追記writer。
 * append-only/fsyncあり/プロセスローカルロック（ファイルロックは取らない）。
 *
 * 設計判断:
 * - fs.appendFileSync は内部で open(O_APPEND)+write+close を呼ぶ。
 *   O_APPEND は POSIX atomic 追記なので、複数プロセスからの concurrent 書き込みでも
 *   行の混入は起きない。fsync で耐クラッシュ性を担保する。
 * - 失敗時は例外を投げ、呼び出し側（save hook）が SQLite 挿入をスキップする
 *   フェイルファスト方針に従う（設計書 §3.3）。
 */
export class JsonlWriter {
  constructor(private readonly jsonlDir: string) {
    ensureJsonlDir(jsonlDir);
  }

  /**
   * 1件以上のレコードを今月のJSONLファイルにappendする。
   * 戻り値は書き込まれた絶対パス。
   */
  appendRecords(records: JsonlChunkRecord[], now: Date = new Date()): string {
    if (records.length === 0) {
      return getJsonlFilePath(this.jsonlDir, now);
    }
    const filePath = getJsonlFilePath(this.jsonlDir, now);
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';

    // O_APPEND atomic write + fsync
    const fd = fs.openSync(filePath, 'a');
    try {
      fs.writeSync(fd, lines);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return filePath;
  }
}
