import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { PendingPromptV2, TurnCheckpointCandidate } from '@/checkpoint/types';
import { createTurnKey } from '@/checkpoint/identity';
import { writePendingPrompt, readPendingPrompts } from '@/checkpoint/state';
import type { RuntimeAdapter, AdapterExtraction, AdapterEnvironment } from '@/checkpoint/adapter';
import {
  parseKimiPromptInput,
  parseKimiSessionEndInput,
  findWireJsonlPath,
  extractAssistantFromWireJsonl,
} from '@/hooks/kimi';

export interface KimiPromptPayload {
  hook_event_name?: string;
  session_id: string;
  cwd?: string;
  prompt?: string;
}

export interface KimiStopPayload {
  hook_event_name?: string;
  session_id: string;
  cwd?: string;
}

export interface KimiSessionEndPayload {
  hook_event_name?: string;
  session_id: string;
  cwd?: string;
  reason?: string;
}

function resolveProjectPath(rawPath: string): string {
  try {
    return fs.realpathSync(rawPath);
  } catch {
    return rawPath;
  }
}

export const kimiAdapter: RuntimeAdapter<
  KimiPromptPayload,
  KimiStopPayload,
  KimiSessionEndPayload
> = {
  parsePrompt(raw: string): KimiPromptPayload | null {
    const parsed = parseKimiPromptInput(raw);
    if (!parsed) return null;
    return {
      hook_event_name: parsed.hook_event_name,
      session_id: parsed.session_id,
      cwd: parsed.cwd,
      prompt: parsed.prompt,
    };
  },

  parseStop(raw: string): KimiStopPayload | null {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (typeof data.session_id !== 'string' || !data.session_id) return null;
      return {
        hook_event_name:
          typeof data.hook_event_name === 'string' ? data.hook_event_name : undefined,
        session_id: data.session_id,
        cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
      };
    } catch {
      return null;
    }
  },

  parseSessionEnd(raw: string): KimiSessionEndPayload | null {
    const parsed = parseKimiSessionEndInput(raw);
    if (!parsed) return null;
    return {
      hook_event_name: parsed.hook_event_name,
      session_id: parsed.session_id,
      cwd: parsed.cwd,
      reason: parsed.reason,
    };
  },

  async capturePrompt(
    payload: KimiPromptPayload,
    env: AdapterEnvironment
  ): Promise<PendingPromptV2 | null> {
    if (!payload.prompt || !payload.session_id) return null;

    const pendingKey = `kimi:${payload.session_id}:${randomUUID()}`;
    const turnSequence = env.getOrCreateTurnSequence('kimi', payload.session_id, pendingKey);
    const sourceOrder = String(turnSequence).padStart(20, '0');

    const pending: PendingPromptV2 = {
      version: 2,
      runtime: 'kimi',
      sessionId: payload.session_id,
      projectPath: payload.cwd || process.cwd(),
      prompt: payload.prompt,
      source: {},
      pendingKey,
      turnSequence,
      sourceOrder,
      createdAt: env.now().toISOString(),
    };

    writePendingPrompt(env.stateRoot, pending);
    return pending;
  },

  async extractStop(payload: KimiStopPayload, env: AdapterEnvironment): Promise<AdapterExtraction> {
    void payload;
    void env;
    return {
      status: 'deferred',
      candidates: [],
      finalization: { pendingPaths: [] },
      diagnostic: 'Kimi Stop checkpoint deferred: wire schema verification required',
    };
  },

  async extractSessionEnd(
    payload: KimiSessionEndPayload,
    env: AdapterEnvironment
  ): Promise<AdapterExtraction> {
    const pending = readPendingPrompts(env.stateRoot, 'kimi', payload.session_id);
    if (pending.length === 0) {
      return {
        status: 'deferred',
        candidates: [],
        finalization: { pendingPaths: [] },
        diagnostic: 'no pending prompts',
      };
    }

    const wirePath = findWireJsonlPath(payload.session_id);
    const assistantText = wirePath ? extractAssistantFromWireJsonl(wirePath) : '';
    if (!assistantText) {
      return {
        status: 'deferred',
        candidates: [],
        finalization: { pendingPaths: [] },
        diagnostic: 'no assistant text from wire',
      };
    }

    const allPrompts = pending.map((p) => p.prompt).join('\n\n');
    const projectPath = resolveProjectPath(payload.cwd ?? pending[0].projectPath);

    const sourceIdentity = `kimi:${payload.session_id}:${pending[0].pendingKey}`;
    const turnKey = createTurnKey('kimi', payload.session_id, sourceIdentity);

    const fileSize = wirePath && fs.existsSync(wirePath) ? fs.statSync(wirePath).size : 0;

    const candidate: TurnCheckpointCandidate = {
      runtime: 'kimi',
      sessionId: payload.session_id,
      turnKey,
      sourceOrder: pending[0].sourceOrder,
      observedThrough: { kind: 'source_offset', generation: 0, offset: fileSize },
      projectPath,
      completedAt: env.now().toISOString(),
      prompt: allPrompts,
      assistant: assistantText,
      messages: [],
    };

    const pendingPaths = pending.filter((p) => p.source.path).map((p) => p.source.path!);

    return {
      status: 'ready',
      candidates: [candidate],
      finalization: { pendingPaths },
    };
  },
};
