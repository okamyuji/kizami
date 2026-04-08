import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { setupHooks } from '../../src/hooks/setup';

describe('setupHooks', () => {
  let tmpDir: string;
  let settingsPath: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-setup-'));
    settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    dbPath = path.join(tmpDir, 'kizami', 'memory.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create settings.json with hook entries', async () => {
    await setupHooks({ settingsPath, dbPath });

    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);

    expect(settings.hooks.SessionEnd[0].hooks[0].type).toBe('command');
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain('kizami save');
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('kizami recall');
  });

  it('should preserve existing settings', async () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ apiKey: 'test-key', other: true }), 'utf-8');

    await setupHooks({ settingsPath, dbPath });

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.apiKey).toBe('test-key');
    expect(settings.other).toBe(true);
    expect(settings.hooks).toBeDefined();
  });

  it('should preserve non-kizami hooks', async () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              hooks: [{ type: 'command', command: 'other-tool save' }],
            },
          ],
        },
      }),
      'utf-8'
    );

    await setupHooks({ settingsPath, dbPath });

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    // Should have both: the existing non-kizami hook and the new kizami hook
    expect(settings.hooks.SessionEnd).toHaveLength(2);
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain('other-tool');
    expect(settings.hooks.SessionEnd[1].hooks[0].command).toContain('kizami save');
  });

  it('should replace existing kizami hooks on re-run', async () => {
    // Run setup twice
    await setupHooks({ settingsPath, dbPath });
    await setupHooks({ settingsPath, dbPath });

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    // Should still have only one kizami hook per event
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('should initialize the database', async () => {
    await setupHooks({ settingsPath, dbPath });

    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
