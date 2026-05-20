/**
 * JSONL正本の1行スキーマ。
 * - v: スキーマバージョン（将来のフォーマット拡張用）
 * - id: crypto.randomUUID() による global unique識別子
 * - createdAt: 時系列ソートはこのフィールドで行う（ULID不要）
 * - embedding: hybridモード時のみ hex-encoded float32 をインライン保存
 */
export interface JsonlChunkRecord {
  v: 1;
  type: 'chunk';
  id: string;
  sessionId: string;
  projectPath: string;
  chunkIndex: number;
  content: string;
  role: 'human' | 'assistant' | 'mixed';
  metadata: string | null;
  tokenCount: number;
  createdAt: string;
  embedding?: string;
  embeddingDim?: number;
  embeddingModel?: string;
}

export type JsonlRecord = JsonlChunkRecord;
