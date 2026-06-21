import type { EngramConfig } from '@/config';
import type { HookRuntime, PendingPromptV2, TurnCheckpointCandidate } from './types';
import type { RuntimeCursorV2 } from './state';

export interface AdapterExtraction {
  status: 'ready' | 'deferred';
  candidates: TurnCheckpointCandidate[];
  finalization: {
    pendingPaths: string[];
    cursorPath?: string;
    cursorAfter?: RuntimeCursorV2;
  };
  diagnostic?: string;
}

export interface AdapterEnvironment {
  config: EngramConfig;
  stateRoot: string;
  now(): Date;
  getOrCreateTurnSequence(runtime: HookRuntime, sessionId: string, pendingKey: string): number;
  allocateTurnSequenceRange(runtime: HookRuntime, sessionId: string, count: number): number[];
  reserveObservationSequence(runtime: HookRuntime, sessionId: string): number;
  log(message: string): void;
}

export interface RuntimeAdapter<TPrompt, TStop, TEnd> {
  parsePrompt(raw: string): TPrompt | null;
  parseStop(raw: string): TStop | null;
  parseSessionEnd(raw: string): TEnd | null;
  capturePrompt(payload: TPrompt, env: AdapterEnvironment): Promise<PendingPromptV2 | null>;
  extractStop(payload: TStop, env: AdapterEnvironment): Promise<AdapterExtraction>;
  extractSessionEnd(payload: TEnd, env: AdapterEnvironment): Promise<AdapterExtraction>;
}
