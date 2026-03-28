import type Database from 'better-sqlite3';
import type { Chunk } from '../db/store';
import { Store } from '../db/store';

export interface MergeOptions {
  similarityThreshold?: number; // 0.0-1.0、デフォルト0.6
  projectPath?: string; // プロジェクトで絞り込み
  dryRun?: boolean;
}

export interface MergeResult {
  groupsFound: number;
  chunksMerged: number;
  chunksRemoved: number;
}

/**
 * テキストからtrigramの集合を生成します。
 */
function extractTrigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const trigrams = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    trigrams.add(normalized.substring(i, i + 3));
  }
  return trigrams;
}

/**
 * Jaccard類似度を計算します。
 * 2つの集合の共通要素数を和集合要素数で割った値です。
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;

  for (const item of smaller) {
    if (larger.has(item)) {
      intersection++;
    }
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * チャンクの「情報量」を推定します。
 * マージ時に最も情報量の多いチャンクを残します。
 */
function informationScore(chunk: Chunk): number {
  let score = 0;

  // コンテンツ長(長いほど情報量が多い)
  score += Math.min(chunk.content.length / 500, 2);

  // メタデータの豊富さ
  if (chunk.metadata) {
    score += chunk.metadata.filePaths.length * 0.3;
    score += chunk.metadata.toolNames.length * 0.2;
  }

  // roleがmixedならユーザーとアシスタント両方の情報を含む
  if (chunk.role === 'mixed') score += 0.5;

  return score;
}

interface ChunkRow {
  id: number;
  session_id: string;
  project_path: string;
  chunk_index: number;
  content: string;
  role: string;
  metadata: string | null;
  created_at: string;
  token_count: number;
}

function rowToChunk(row: ChunkRow): Chunk {
  let metadata: Chunk['metadata'];
  try {
    metadata = JSON.parse(row.metadata ?? '{}');
  } catch {
    metadata = { filePaths: [], toolNames: [], errorMessages: [] };
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    projectPath: row.project_path,
    chunkIndex: row.chunk_index,
    content: row.content,
    role: row.role as 'human' | 'assistant' | 'mixed',
    metadata,
    createdAt: row.created_at,
    tokenCount: row.token_count,
  };
}

/**
 * 類似チャンクを検出してグループ化します。
 * Union-Findアルゴリズムで推移的に類似なチャンクをグループにまとめます。
 */
function findSimilarGroups(
  chunks: Chunk[],
  trigrams: Map<number, Set<string>>,
  threshold: number
): Chunk[][] {
  // Union-Find
  const parent = new Map<number, number>();
  for (const c of chunks) {
    parent.set(c.id!, c.id!);
  }

  function find(x: number): number {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // ペアワイズ比較（同一セッション内のみ）
  const bySession = new Map<string, Chunk[]>();
  for (const c of chunks) {
    const group = bySession.get(c.sessionId) ?? [];
    group.push(c);
    bySession.set(c.sessionId, group);
  }

  for (const [, sessionChunks] of bySession) {
    for (let i = 0; i < sessionChunks.length; i++) {
      for (let j = i + 1; j < sessionChunks.length; j++) {
        const a = sessionChunks[i];
        const b = sessionChunks[j];
        const tA = trigrams.get(a.id!);
        const tB = trigrams.get(b.id!);
        if (tA && tB) {
          const sim = jaccardSimilarity(tA, tB);
          if (sim >= threshold) {
            union(a.id!, b.id!);
          }
        }
      }
    }
  }

  // グループ化
  const groups = new Map<number, Chunk[]>();
  for (const c of chunks) {
    const root = find(c.id!);
    const group = groups.get(root) ?? [];
    group.push(c);
    groups.set(root, group);
  }

  // 2つ以上のチャンクを含むグループのみ返す
  return [...groups.values()].filter((g) => g.length >= 2);
}

/**
 * 類似チャンクを検出してマージします。
 * 各グループ内で最も情報量の多いチャンクを残し、他を削除します。
 */
export function mergeChunks(db: Database.Database, options?: MergeOptions): MergeResult {
  const threshold = options?.similarityThreshold ?? 0.6;
  const dryRun = options?.dryRun ?? false;
  const store = new Store(db);

  // チャンクを取得
  let rows: ChunkRow[];
  if (options?.projectPath) {
    rows = db
      .prepare(
        `SELECT id, session_id, project_path, chunk_index, content, role, metadata, created_at, token_count
         FROM chunks WHERE project_path = ? ORDER BY session_id, chunk_index`
      )
      .all(options.projectPath) as ChunkRow[];
  } else {
    rows = db
      .prepare(
        `SELECT id, session_id, project_path, chunk_index, content, role, metadata, created_at, token_count
         FROM chunks ORDER BY session_id, chunk_index`
      )
      .all() as ChunkRow[];
  }

  const chunks = rows.map(rowToChunk);

  // trigram計算
  const trigrams = new Map<number, Set<string>>();
  for (const c of chunks) {
    trigrams.set(c.id!, extractTrigrams(c.content));
  }

  // 類似グループ検出
  const groups = findSimilarGroups(chunks, trigrams, threshold);

  let chunksMerged = 0;
  let chunksRemoved = 0;

  for (const group of groups) {
    // 情報量で降順ソートし、最良のチャンクを残す
    group.sort((a, b) => informationScore(b) - informationScore(a));
    // group[0]が最も情報量が多いチャンク(残す)、残りを削除
    const toRemove = group.slice(1);

    if (!dryRun) {
      for (const chunk of toRemove) {
        store.deleteChunk(chunk.id!);
      }
    }

    chunksMerged += group.length;
    chunksRemoved += toRemove.length;
  }

  return {
    groupsFound: groups.length,
    chunksMerged,
    chunksRemoved,
  };
}

// テスト用にエクスポート
export { extractTrigrams, jaccardSimilarity, informationScore };
