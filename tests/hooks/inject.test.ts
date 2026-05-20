import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInject } from '@/hooks/inject';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { getDefaultConfig } from '@/config';
import type { EngramConfig } from '@/config';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-inject-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function writeTestConfig(dir: string): { configPath: string; config: EngramConfig } {
  const defaults = getDefaultConfig();
  const dbPath = path.join(dir, 'memory.db');
  const config: EngramConfig = {
    ...defaults,
    database: { path: dbPath },
    storage: { ...defaults.storage, jsonlDir: path.join(dir, 'jsonl') },
    hooks: { ...defaults.hooks, injectRecentCount: 2 },
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  return { configPath, config };
}

describe('handleInject', () => {
  it('returns formatted recent chunks for the project', async () => {
    const dir = makeTmpDir();
    const { configPath, config } = writeTestConfig(dir);

    const db = getDatabase(config.database.path);
    initializeSchema(db);
    const store = new Store(db);
    const projectPath = fs.realpathSync(os.tmpdir());

    store.insertChunks([
      {
        sessionId: 's1',
        projectPath,
        chunkIndex: 0,
        content: 'first',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 5,
        createdAt: '2026-05-20T01:00:00Z',
      },
      {
        sessionId: 's2',
        projectPath,
        chunkIndex: 0,
        content: 'second',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 5,
        createdAt: '2026-05-21T02:00:00Z',
      },
      {
        sessionId: 's3',
        projectPath,
        chunkIndex: 0,
        content: 'third',
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
        tokenCount: 5,
        createdAt: '2026-05-21T03:00:00Z',
      },
    ]);
    db.close();

    const result = await handleInject(
      { hook_event_name: 'SessionStart', session_id: 'new', cwd: projectPath },
      configPath
    );
    // injectRecentCount=2 なので最新2件 (third, second) が含まれるはず
    expect(result).toContain('third');
    expect(result).toContain('second');
    expect(result).not.toContain('first');
  });

  it('returns empty string when no chunks exist for the project', async () => {
    const dir = makeTmpDir();
    const { configPath } = writeTestConfig(dir);
    const result = await handleInject(
      { hook_event_name: 'SessionStart', session_id: 'x', cwd: '/no/such/path' },
      configPath
    );
    expect(result).toBe('');
  });
});
