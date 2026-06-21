import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { PendingPromptV2, TurnCheckpointCandidate } from '@/checkpoint/types';
import { createTurnKey } from '@/checkpoint/identity';
import { writePendingPrompt, readPendingPrompts } from '@/checkpoint/state';
import type { RuntimeAdapter, AdapterExtraction, AdapterEnvironment } from '@/checkpoint/adapter';

export interface CodexPromptPayload {
  hook_event_name?: string;
  session_id: string;
  turn_id?: string;
  cwd?: string;
  prompt: string;
  model?: string;
}

export interface CodexStopPayload {
  hook_event_name?: string;
  session_id: string;
  turn_id?: string;
  cwd?: string;
  transcript_path?: string | null;
  last_assistant_message?: string | null;
  model?: string;
}

function resolveProjectPath(rawPath: string): string {
  try {
    return fs.realpathSync(rawPath);
  } catch {
    return rawPath;
  }
}

export const codexAdapter: RuntimeAdapter<CodexPromptPayload, CodexStopPayload, CodexStopPayload> =
  {
    parsePrompt(raw: string): CodexPromptPayload | null {
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (typeof data.session_id !== 'string' || !data.session_id) return null;
        if (typeof data.prompt !== 'string') return null;
        return {
          hook_event_name:
            typeof data.hook_event_name === 'string' ? data.hook_event_name : undefined,
          session_id: data.session_id,
          turn_id: typeof data.turn_id === 'string' ? data.turn_id : undefined,
          cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
          prompt: data.prompt,
          model: typeof data.model === 'string' ? data.model : undefined,
        };
      } catch {
        return null;
      }
    },

    parseStop(raw: string): CodexStopPayload | null {
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (typeof data.session_id !== 'string' || !data.session_id) return null;
        return {
          hook_event_name:
            typeof data.hook_event_name === 'string' ? data.hook_event_name : undefined,
          session_id: data.session_id,
          turn_id: typeof data.turn_id === 'string' ? data.turn_id : undefined,
          cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
          transcript_path:
            typeof data.transcript_path === 'string' ? data.transcript_path : undefined,
          last_assistant_message:
            typeof data.last_assistant_message === 'string'
              ? data.last_assistant_message
              : undefined,
          model: typeof data.model === 'string' ? data.model : undefined,
        };
      } catch {
        return null;
      }
    },

    parseSessionEnd(raw: string): CodexStopPayload | null {
      return this.parseStop(raw);
    },

    async capturePrompt(
      payload: CodexPromptPayload,
      env: AdapterEnvironment
    ): Promise<PendingPromptV2 | null> {
      if (!payload.prompt || !payload.session_id) return null;

      const promptHash = createHash('sha256').update(payload.prompt).digest('hex').slice(0, 24);
      const pendingKey = payload.turn_id
        ? `codex:${payload.session_id}:${payload.turn_id}`
        : `codex:${payload.session_id}:prompt:${promptHash}`;

      const turnSequence = env.getOrCreateTurnSequence('codex', payload.session_id, pendingKey);
      const sourceOrder = String(turnSequence).padStart(20, '0');

      const pending: PendingPromptV2 = {
        version: 2,
        runtime: 'codex',
        sessionId: payload.session_id,
        runtimeTurnId: payload.turn_id,
        projectPath: payload.cwd || process.cwd(),
        prompt: payload.prompt,
        model: payload.model,
        source: {},
        pendingKey,
        turnSequence,
        sourceOrder,
        createdAt: env.now().toISOString(),
      };

      writePendingPrompt(env.stateRoot, pending);
      return pending;
    },

    async extractStop(
      payload: CodexStopPayload,
      env: AdapterEnvironment
    ): Promise<AdapterExtraction> {
      const assistant = payload.last_assistant_message?.trim();
      if (!assistant) {
        return {
          status: 'deferred',
          candidates: [],
          finalization: { pendingPaths: [] },
          diagnostic: 'no assistant message',
        };
      }

      const pending = readPendingPrompts(env.stateRoot, 'codex', payload.session_id);
      let matchedPending: PendingPromptV2 | undefined;

      if (payload.turn_id) {
        matchedPending = pending.find((p) => p.runtimeTurnId === payload.turn_id);
      }
      if (!matchedPending && pending.length > 0) {
        matchedPending = pending[pending.length - 1];
      }

      if (!matchedPending) {
        return {
          status: 'deferred',
          candidates: [],
          finalization: { pendingPaths: [] },
          diagnostic: 'no pending prompt',
        };
      }

      const sourceIdentity = payload.turn_id
        ? `turn_id:${payload.turn_id}`
        : `pending:${matchedPending.pendingKey}`;

      const turnKey = createTurnKey('codex', payload.session_id, sourceIdentity);
      const projectPath = resolveProjectPath(payload.cwd ?? matchedPending.projectPath);

      const obsSequence = env.reserveObservationSequence('codex', payload.session_id);

      const candidate: TurnCheckpointCandidate = {
        runtime: 'codex',
        sessionId: payload.session_id,
        turnKey,
        sourceOrder: matchedPending.sourceOrder,
        observedThrough: { kind: 'delivery_sequence', sequence: obsSequence },
        projectPath,
        completedAt: env.now().toISOString(),
        prompt: matchedPending.prompt,
        assistant,
        messages: [],
        model: payload.model ?? matchedPending.model,
      };

      const pendingPaths = matchedPending.source.path ? [matchedPending.source.path] : [];

      return {
        status: 'ready',
        candidates: [candidate],
        finalization: { pendingPaths },
      };
    },

    async extractSessionEnd(
      payload: CodexStopPayload,
      env: AdapterEnvironment
    ): Promise<AdapterExtraction> {
      return this.extractStop(payload, env);
    },
  };
