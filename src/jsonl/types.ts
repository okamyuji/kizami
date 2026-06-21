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

import type { TurnCheckpointV2 } from '@/checkpoint/types';

export type JsonlV2Payload =
  | {
      v: 2;
      type: 'session_reset';
      txId: string;
      sessionId: string;
      historyEpoch: number;
      reason: 'legacy_mismatch';
    }
  | ({ v: 2; type: 'turn_checkpoint'; txId: string } & TurnCheckpointV2);

export type JsonlV2Record =
  | { v: 2; type: 'tx_begin'; txId: string; createdAt: string }
  | JsonlV2Payload
  | {
      v: 2;
      type: 'tx_commit';
      txId: string;
      recordCount: number;
      payloadDigest: string;
      createdAt: string;
    };

export type JsonlRecord = JsonlChunkRecord | JsonlV2Record;

export interface SerializedJsonlTransaction {
  txId: string;
  createdAt: string;
  targetPath: string;
  payloadLines: string[];
  payloadDigest: string;
  allLines: string[];
  records: JsonlV2Record[];
}

export interface CommittedTransaction {
  txId: string;
  createdAt: string;
  filePath: string;
  beginOffset: number;
  endOffset: number;
  payloadDigest: string;
  payloads: JsonlV2Payload[];
}

export interface ValidatedTransactionFrame {
  txId: string;
  createdAt: string;
  payloadDigest: string;
  payloads: JsonlV2Payload[];
}

export type JsonlLineResult =
  | { kind: 'record'; offset: number; endOffset: number; line: string; record: JsonlRecord }
  | { kind: 'diagnostic'; offset: number; endOffset: number; line: string; message: string };

export type CanonicalTransactionResult =
  | { kind: 'transaction'; transaction: CommittedTransaction }
  | { kind: 'diagnostic'; filePath: string; offset: number; txId?: string; message: string };
