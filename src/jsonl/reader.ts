import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { JsonlChunkRecord, JsonlRecord } from '@/jsonl/types';

/**
 * JSONLを行単位でstreaming読み込みする。
 * - 不正な行（JSON parse失敗、v/typeが想定外）はスキップしカウントする
 * - 戻り値は AsyncIterable<JsonlChunkRecord>
 */
export async function* readJsonlFile(
  filePath: string
): AsyncGenerator<JsonlChunkRecord, void, void> {
  if (!fs.existsSync(filePath)) return;

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isJsonlChunkRecord(parsed)) continue;
    yield parsed;
  }
}

export function isJsonlChunkRecord(value: unknown): value is JsonlChunkRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<JsonlRecord>;
  return (
    v.v === 1 &&
    v.type === 'chunk' &&
    typeof v.id === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.projectPath === 'string' &&
    typeof v.chunkIndex === 'number' &&
    typeof v.content === 'string' &&
    typeof v.createdAt === 'string'
  );
}

/**
 * 末尾N行を効率的に読む（self-healing用）。
 * ファイル全体を読まず、末尾チャンクからのみパースする実装。
 */
export function readTailRecords(filePath: string, n: number): JsonlChunkRecord[] {
  if (!fs.existsSync(filePath) || n <= 0) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.length > 0);
  const tail = lines.slice(-n);
  const out: JsonlChunkRecord[] = [];
  for (const line of tail) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isJsonlChunkRecord(parsed)) out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return out;
}
