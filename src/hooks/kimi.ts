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
