import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { savePendingCodexPrompt, handleCodexStop } from '@/hooks/codex';
import { getDefaultConfig } from '@/config';
import type { EngramConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-codex-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(dir: string): { configPath: string; config: EngramConfig } {
  const defaults = getDefaultConfig();
  const config: EngramConfig = {
    ...defaults,
    database: { path: path.join(dir, 'memory.db') },
    storage: { ...defaults.storage, jsonlDir: path.join(dir, 'jsonl') },
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  return { configPath, config };
}

describe('Codex hook capture', () => {
  it('captures prompt on UserPromptSubmit and saves a turn on Stop', async () => {
    const dir = makeTmpDir();
    const { configPath, config } = writeConfig(dir);

    savePendingCodexPrompt(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'codex-session',
        turn_id: 'turn-1',
        cwd: dir,
        prompt: 'How should we support Codex hooks?',
        model: 'gpt-5.5',
      },
      configPath
    );

    await handleCodexStop(
      {
        hook_event_name: 'Stop',
        session_id: 'codex-session',
        turn_id: 'turn-1',
        cwd: dir,
        last_assistant_message: 'Use Stop for saving and UserPromptSubmit for recall.',
        model: 'gpt-5.5',
      },
      configPath
    );

    const db = getDatabase(config.database.path);
    initializeSchema(db);
    const store = new Store(db);
    const stats = store.getStats();
    const sessions = store.getSessionList(fs.realpathSync(dir));
    const jsonlFiles = fs.readdirSync(config.storage.jsonlDir).filter((f) => f.endsWith('.jsonl'));

    expect(stats.totalChunks).toBe(1);
    expect(stats.totalSessions).toBe(1);
    expect(sessions[0].sessionId).toBe('codex-session');
    expect(sessions[0].chunkCount).toBe(1);
    expect(jsonlFiles.length).toBe(1);
    db.close();
  });

  it('does not save Stop events without a pending prompt', async () => {
    const dir = makeTmpDir();
    const { configPath, config } = writeConfig(dir);

    await handleCodexStop(
      {
        hook_event_name: 'Stop',
        session_id: 'missing-prompt',
        cwd: dir,
        last_assistant_message: 'No prompt was captured.',
      },
      configPath
    );

    const db = getDatabase(config.database.path);
    initializeSchema(db);
    const store = new Store(db);
    expect(store.getStats().totalChunks).toBe(0);
    db.close();
  });

  it('does not duplicate a turn when Stop is retried', async () => {
    const dir = makeTmpDir();
    const { configPath, config } = writeConfig(dir);

    const prompt = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'retry-session',
      turn_id: 'turn-retry',
      cwd: dir,
      prompt: 'Retry-safe save?',
    };
    const stop = {
      hook_event_name: 'Stop',
      session_id: 'retry-session',
      turn_id: 'turn-retry',
      cwd: dir,
      last_assistant_message: 'Yes, deterministic external IDs prevent duplicates.',
    };

    savePendingCodexPrompt(prompt, configPath);
    await handleCodexStop(stop, configPath);
    savePendingCodexPrompt(prompt, configPath);
    await handleCodexStop(stop, configPath);

    const db = getDatabase(config.database.path);
    initializeSchema(db);
    const store = new Store(db);
    expect(store.getStats().totalChunks).toBe(1);
    expect(store.getSession('retry-session')?.chunkCount).toBe(1);
    db.close();
  });

  it('keeps pending prompts separate by turn_id', async () => {
    const dir = makeTmpDir();
    const { configPath, config } = writeConfig(dir);

    savePendingCodexPrompt(
      {
        session_id: 'multi-turn',
        turn_id: 'turn-a',
        cwd: dir,
        prompt: 'Prompt A',
      },
      configPath
    );
    savePendingCodexPrompt(
      {
        session_id: 'multi-turn',
        turn_id: 'turn-b',
        cwd: dir,
        prompt: 'Prompt B',
      },
      configPath
    );
    await handleCodexStop(
      {
        session_id: 'multi-turn',
        turn_id: 'turn-a',
        cwd: dir,
        last_assistant_message: 'Answer A',
      },
      configPath
    );
    await handleCodexStop(
      {
        session_id: 'multi-turn',
        turn_id: 'turn-b',
        cwd: dir,
        last_assistant_message: 'Answer B',
      },
      configPath
    );

    const db = getDatabase(config.database.path);
    initializeSchema(db);
    const store = new Store(db);
    expect(store.getStats().totalChunks).toBe(2);
    expect(store.getChunk(1)?.content).toContain('Prompt A');
    expect(store.getChunk(2)?.content).toContain('Prompt B');
    db.close();
  });
});
