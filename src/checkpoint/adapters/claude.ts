import * as fs from 'node:fs';
import { parseTranscript } from '@/parser/transcript';
import type { TranscriptMessage } from '@/parser/transcript';
import type {
  PendingPromptV2,
  TurnCheckpointCandidate,
  ObservationBoundaryV2,
} from '@/checkpoint/types';
import { createTurnKey } from '@/checkpoint/identity';
import { writePendingPrompt, readPendingPrompts } from '@/checkpoint/state';
import type { RuntimeAdapter, AdapterExtraction, AdapterEnvironment } from '@/checkpoint/adapter';

export interface ClaudePromptPayload {
  hook_event_name?: string;
  session_id: string;
  cwd?: string;
  prompt?: string;
  transcript_path?: string;
}

export interface ClaudeStopPayload {
  hook_event_name?: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

export type ClaudeSessionEndPayload = ClaudeStopPayload;

function getFileIdentity(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();
}

function extractAssistantText(messages: TranscriptMessage[], fromIndex: number): string {
  const parts: string[] = [];
  for (let i = fromIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.kind === 'user') break;
    if (msg.kind === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'text') parts.push(block.text);
      }
    }
  }
  return parts.join('');
}

async function extractTurns(
  payload: ClaudeStopPayload,
  env: AdapterEnvironment,
  toEof: boolean
): Promise<AdapterExtraction> {
  if (!fs.existsSync(payload.transcript_path)) {
    return {
      status: 'deferred',
      candidates: [],
      finalization: { pendingPaths: [] },
      diagnostic: 'transcript file not found',
    };
  }

  const messages = await parseTranscript(payload.transcript_path);
  if (messages.length === 0) {
    return {
      status: 'deferred',
      candidates: [],
      finalization: { pendingPaths: [] },
      diagnostic: 'empty transcript',
    };
  }

  const fileSize = fs.statSync(payload.transcript_path).size;

  const pendingPrompts = readPendingPrompts(env.stateRoot, 'claude', payload.session_id);

  // Find the last user message index
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) {
    return {
      status: 'deferred',
      candidates: [],
      finalization: { pendingPaths: [] },
      diagnostic: 'no user message',
    };
  }

  // Check we have at least one assistant message after the last user
  const hasAssistant = messages.slice(lastUserIdx + 1).some((m) => m.kind === 'assistant');
  if (!hasAssistant) {
    return {
      status: 'deferred',
      candidates: [],
      finalization: { pendingPaths: [] },
      diagnostic: 'no assistant response yet',
    };
  }

  // Validate last_assistant_message if provided (Stop only, not SessionEnd)
  if (!toEof && payload.last_assistant_message) {
    const extractedAssistant = normalizeText(extractAssistantText(messages, lastUserIdx + 1));
    const expected = normalizeText(payload.last_assistant_message);
    if (extractedAssistant !== expected) {
      return {
        status: 'deferred',
        candidates: [],
        finalization: { pendingPaths: [] },
        diagnostic: 'assistant text mismatch',
      };
    }
  }

  const userMsg = messages[lastUserIdx];
  const prompt = userMsg.kind === 'user' ? userMsg.text : '';
  const turnMessages = messages.slice(lastUserIdx);
  const assistant = extractAssistantText(messages, lastUserIdx + 1);

  // Determine source identity
  const sourceIdentity =
    pendingPrompts.length > 0
      ? `pending:${pendingPrompts[pendingPrompts.length - 1].pendingKey}`
      : `offset:${lastUserIdx}`;

  const turnKey = createTurnKey('claude', payload.session_id, sourceIdentity);

  const observedThrough: ObservationBoundaryV2 = {
    kind: 'source_offset',
    generation: 0,
    offset: fileSize,
  };

  let projectPath: string;
  try {
    projectPath = fs.realpathSync(payload.cwd);
  } catch {
    projectPath = payload.cwd || process.cwd();
  }

  const candidate: TurnCheckpointCandidate = {
    runtime: 'claude',
    sessionId: payload.session_id,
    turnKey,
    sourceOrder:
      pendingPrompts.length > 0
        ? pendingPrompts[pendingPrompts.length - 1].sourceOrder
        : '00000000000000000001',
    observedThrough,
    projectPath,
    completedAt: env.now().toISOString(),
    prompt,
    assistant,
    messages: turnMessages,
  };

  const pendingPaths = pendingPrompts.filter((p) => p.source.path).map((p) => p.source.path!);

  return {
    status: 'ready',
    candidates: [candidate],
    finalization: { pendingPaths },
  };
}

export const claudeAdapter: RuntimeAdapter<
  ClaudePromptPayload,
  ClaudeStopPayload,
  ClaudeSessionEndPayload
> = {
  parsePrompt(raw: string): ClaudePromptPayload | null {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (typeof data.session_id !== 'string') return null;
      return {
        hook_event_name:
          typeof data.hook_event_name === 'string' ? data.hook_event_name : undefined,
        session_id: data.session_id,
        cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
        prompt: typeof data.prompt === 'string' ? data.prompt : undefined,
        transcript_path:
          typeof data.transcript_path === 'string' ? data.transcript_path : undefined,
      };
    } catch {
      return null;
    }
  },

  parseStop(raw: string): ClaudeStopPayload | null {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (typeof data.session_id !== 'string' || typeof data.transcript_path !== 'string')
        return null;
      return {
        hook_event_name:
          typeof data.hook_event_name === 'string' ? data.hook_event_name : undefined,
        session_id: data.session_id,
        transcript_path: data.transcript_path,
        cwd: typeof data.cwd === 'string' ? data.cwd : process.cwd(),
        stop_hook_active:
          typeof data.stop_hook_active === 'boolean' ? data.stop_hook_active : undefined,
        last_assistant_message:
          typeof data.last_assistant_message === 'string' ? data.last_assistant_message : undefined,
      };
    } catch {
      return null;
    }
  },

  parseSessionEnd(raw: string): ClaudeSessionEndPayload | null {
    return this.parseStop(raw);
  },

  async capturePrompt(
    payload: ClaudePromptPayload,
    env: AdapterEnvironment
  ): Promise<PendingPromptV2 | null> {
    if (!payload.prompt || !payload.session_id) return null;

    const fileIdentity = payload.transcript_path
      ? getFileIdentity(payload.transcript_path)
      : undefined;
    const byteLength =
      payload.transcript_path && fs.existsSync(payload.transcript_path)
        ? fs.statSync(payload.transcript_path).size
        : undefined;

    const pendingKey = `claude:${payload.session_id}:${fileIdentity ?? 'unknown'}:${byteLength ?? 0}`;
    const turnSequence = env.getOrCreateTurnSequence('claude', payload.session_id, pendingKey);
    const sourceOrder = String(turnSequence).padStart(20, '0');

    const pending: PendingPromptV2 = {
      version: 2,
      runtime: 'claude',
      sessionId: payload.session_id,
      projectPath: payload.cwd || process.cwd(),
      prompt: payload.prompt,
      source: {
        path: payload.transcript_path,
        fileIdentity,
        byteLength,
      },
      pendingKey,
      turnSequence,
      sourceOrder,
      createdAt: env.now().toISOString(),
    };

    writePendingPrompt(env.stateRoot, pending);
    return pending;
  },

  async extractStop(
    payload: ClaudeStopPayload,
    env: AdapterEnvironment
  ): Promise<AdapterExtraction> {
    return extractTurns(payload, env, false);
  },

  async extractSessionEnd(
    payload: ClaudeSessionEndPayload,
    env: AdapterEnvironment
  ): Promise<AdapterExtraction> {
    return extractTurns(payload, env, true);
  },
};
