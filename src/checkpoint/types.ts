import type { Chunk } from '@/db/store';
import type { TranscriptMessage } from '@/parser/transcript';

export type HookRuntime = 'claude' | 'codex' | 'kimi';

export interface SourceAnchorV2 {
  path?: string;
  fileIdentity?: string;
  byteLength?: number;
  promptRecordOffset?: number;
  // Plan addition beyond spec Section 4.1: stores the resolved Claude transcript
  // record UUID or Kimi wire user-event ID. Used to compute pendingKey and turnKey
  // once the source record is resolved at Stop time. The file-identity+offset
  // fallback in pendingKey applies only when this field is absent.
  promptRecordId?: string;
}

export interface PendingPromptV2 {
  version: 2;
  runtime: HookRuntime;
  sessionId: string;
  runtimeTurnId?: string;
  projectPath: string;
  prompt: string;
  model?: string;
  source: SourceAnchorV2;
  pendingKey: string;
  turnSequence: number;
  sourceOrder: string;
  createdAt: string;
}

export interface TurnPartV2 {
  partIndex: number;
  externalId: string;
  content: string;
  role: 'human' | 'assistant' | 'mixed';
  metadata: Chunk['metadata'];
  tokenCount: number;
}

export interface TurnCheckpointCandidate {
  runtime: HookRuntime;
  sessionId: string;
  turnKey: string;
  sourceOrder: string;
  observedThrough: ObservationBoundaryV2;
  projectPath: string;
  completedAt: string;
  prompt: string;
  assistant: string;
  messages: TranscriptMessage[];
  model?: string;
}

export interface TurnCheckpointV2 {
  sessionId: string;
  runtime: HookRuntime;
  turnKey: string;
  sourceOrder: string;
  observedThrough: ObservationBoundaryV2;
  historyEpoch: number;
  revision: number;
  contentHash: string;
  completedAt: string;
  projectPath: string;
  parts: TurnPartV2[];
}

export type ObservationBoundaryV2 =
  | { kind: 'source_offset'; generation: number; offset: number }
  | { kind: 'delivery_sequence'; sequence: number };

export type CheckpointCommitStatus =
  | 'inserted'
  | 'already_current'
  | 'stale'
  | 'conflict'
  | 'deferred';

export interface CheckpointCommitResult {
  status: CheckpointCommitStatus;
  turnKey: string;
  revision?: number;
  txId?: string;
  reason?: string;
}
