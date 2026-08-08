import type { HookRuntime } from '@/checkpoint/types';

export type ExecutionStatus = 'failed' | 'succeeded' | 'unknown';

export interface ExecutionObservationV1 {
  executionIndex: number;
  toolName: string;
  command: string;
  status: ExecutionStatus;
  exitCode?: number;
  outputExcerpt: string;
}

export interface StoredExecutionObservation extends ExecutionObservationV1 {
  runtime: HookRuntime;
  sessionId: string;
  projectPath: string;
  turnKey: string;
  sourceOrder: string;
  historyEpoch: number;
  revision: number;
  completedAt: string;
}

export interface VerifiedErrorResolution {
  runtime: HookRuntime;
  projectPath: string;
  sessionId: string;
  command: string;
  firstFailureTurnKey: string;
  firstFailureExecutionIndex: number;
  lastFailureTurnKey: string;
  lastFailureExecutionIndex: number;
  failureCount: number;
  failureOutputExcerpt: string;
  successTurnKey: string;
  successExecutionIndex: number;
  successOutputExcerpt: string;
  verifiedAt: string;
}
