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

import type { TurnCheckpointV2 } from '@/checkpoint/types';

export type JsonlV2Record =
  | { v: 2; type: 'tx_begin'; txId: string; createdAt: string }
  | {
      v: 2;
      type: 'session_reset';
      txId: string;
      sessionId: string;
      historyEpoch: number;
      reason: 'legacy_mismatch';
    }
  | ({ v: 2; type: 'turn_checkpoint'; txId: string } & TurnCheckpointV2)
  | {
      v: 2;
      type: 'tx_commit';
      txId: string;
      recordCount: number;
      payloadDigest: string;
      createdAt: string;
    };
