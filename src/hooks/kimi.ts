import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface KimiBaseInput {
  hook_event_name?: string;
  session_id: string;
  cwd?: string;
  source?: string;
}

export interface KimiPromptInput {
  hook_event_name?: string;
  session_id: string;
  cwd?: string;
  prompt?: string;
}

export interface KimiSessionEndInput {
  hook_event_name?: string;
  session_id: string;
  cwd?: string;
  reason?: string;
}

export function parseKimiSessionStartInput(raw: string): KimiBaseInput | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.session_id !== 'string' || !data.session_id) return null;
    return {
      hook_event_name: typeof data.hook_event_name === 'string' ? data.hook_event_name : undefined,
      session_id: data.session_id,
      cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
      source: typeof data.source === 'string' ? data.source : undefined,
    };
  } catch {
    return null;
  }
}

export function parseKimiPromptInput(raw: string): KimiPromptInput | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.session_id !== 'string' || !data.session_id) return null;
    const rawPrompt = typeof data.prompt === 'string' ? data.prompt : undefined;
    return {
      hook_event_name: typeof data.hook_event_name === 'string' ? data.hook_event_name : undefined,
      session_id: data.session_id,
      cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
      prompt: rawPrompt !== undefined ? rawPrompt.trim() : undefined,
    };
  } catch {
    return null;
  }
}

export function parseKimiSessionEndInput(raw: string): KimiSessionEndInput | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.session_id !== 'string' || !data.session_id) return null;
    return {
      hook_event_name: typeof data.hook_event_name === 'string' ? data.hook_event_name : undefined,
      session_id: data.session_id,
      cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
      reason: typeof data.reason === 'string' ? data.reason : undefined,
    };
  } catch {
    return null;
  }
}

interface PendingKimiTurn {
  sessionId: string;
  cwd: string;
  prompt: string;
  createdAt: string;
}

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function savePendingKimiPrompt(
  input: { session_id: string; cwd?: string; prompt?: string },
  pendingDir: string
): void {
  const prompt = input.prompt?.trim();
  if (!prompt) return;

  const pending: PendingKimiTurn = {
    sessionId: input.session_id,
    cwd: input.cwd ?? process.cwd(),
    prompt,
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(pendingDir, { recursive: true });
  const key = `${safeFilePart(input.session_id)}-${hashText(prompt)}`;
  fs.writeFileSync(path.join(pendingDir, `${key}.json`), JSON.stringify(pending), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function collectPendingKimiTurns(
  sessionId: string,
  pendingDir: string,
  cleanup = false
): PendingKimiTurn[] {
  if (!fs.existsSync(pendingDir)) return [];

  const prefix = `${safeFilePart(sessionId)}-`;
  const now = Date.now();
  const results: PendingKimiTurn[] = [];

  for (const entry of fs.readdirSync(pendingDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.json'))
      continue;

    const filePath = path.join(pendingDir, entry.name);
    try {
      const pending = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PendingKimiTurn;
      const age = now - new Date(pending.createdAt).getTime();
      if (age > PENDING_TTL_MS) {
        if (cleanup) fs.rmSync(filePath, { force: true });
        continue;
      }
      results.push(pending);
      if (cleanup) fs.rmSync(filePath, { force: true });
    } catch {
      if (cleanup) fs.rmSync(filePath, { force: true });
    }
  }

  return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function extractAssistantFromWireJsonl(wirePath: string): string {
  let content: string;
  try {
    content = fs.readFileSync(wirePath, 'utf-8');
  } catch {
    return '';
  }

  const lines = content.trim().split('\n');
  let textParts: string[] = [];

  for (const line of lines) {
    let entry: {
      type?: string;
      event?: { type?: string; part?: { type?: string; text?: string } };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== 'context.append_loop_event') continue;
    const evt = entry.event;
    if (!evt) continue;

    if (evt.type === 'step.begin') {
      textParts = [];
    } else if (evt.type === 'content.part' && evt.part?.type === 'text' && evt.part.text) {
      textParts.push(evt.part.text);
    }
  }

  return textParts.join('').trim();
}

export function findWireJsonlPath(sessionId: string, kimiHomeDir?: string): string | undefined {
  const home = kimiHomeDir ?? path.join(process.env['HOME'] ?? '', '.kimi-code');
  const sessionsDir = path.join(home, 'sessions');
  if (!fs.existsSync(sessionsDir)) return undefined;

  for (const wdDir of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!wdDir.isDirectory()) continue;
    const sessionDir = path.join(sessionsDir, wdDir.name, sessionId);
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    if (fs.existsSync(wirePath)) return wirePath;
  }
  return undefined;
}
