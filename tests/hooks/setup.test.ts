import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { setupHooks, uninstallHooks, getSetupStatus } from '../../src/hooks/setup';

describe('setupHooks', () => {
  let tmpDir: string;
  let settingsPath: string;
  let codexHooksPath: string;
  let dbPath: string;
  let configPath: string;
  let jsonlDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-setup-'));
    settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    codexHooksPath = path.join(tmpDir, '.codex', 'hooks.json');
    dbPath = path.join(tmpDir, 'kizami', 'memory.db');
    configPath = path.join(tmpDir, 'kizami', 'config.json');
    jsonlDir = path.join(tmpDir, 'kizami', 'jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupOptions() {
    return { settingsPath, dbPath, configPath, jsonlDir, binPath: 'kizami' };
  }

  it('should create settings.json with hook entries', async () => {
    await setupHooks(setupOptions());

    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);

    expect(settings.hooks.SessionEnd[0].hooks[0].type).toBe('command');
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain('kizami save');
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('kizami recall');
  });

  it('SessionEnd command を background 化して即 exit 0 する', async () => {
    await setupHooks(setupOptions());

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const command: string = settings.hooks.SessionEnd[0].hooks[0].command;

    // stdin を読み切ってから subshell の printf 経由で kizami save に流す
    expect(command).toContain('INPUT=$(cat)');
    expect(command).toContain('printf "%s" "$INPUT" | kizami save --stdin');
    // stdout は捨て、stderr のみログへ。errorLogPath はスペース耐性のためクォート
    expect(command).toMatch(/kizami save --stdin --runtime claude >\/dev\/null 2>> "[^"]+"/);
    // subshell に & を付けて background 起動
    expect(command).toMatch(/&\s*\)/);
    // ラッパー bash は即 exit 0
    expect(command).toContain('exit 0');
    // 旧バグ (</dev/null がパイプ入力を上書きする) の retest
    expect(command).not.toContain('</dev/null');
  });

  it('should preserve existing settings', async () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ apiKey: 'test-key', other: true }), 'utf-8');

    await setupHooks(setupOptions());

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

    await setupHooks(setupOptions());

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    // Should have both: the existing non-kizami hook and the new kizami hook
    expect(settings.hooks.SessionEnd).toHaveLength(2);
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain('other-tool');
    expect(settings.hooks.SessionEnd[1].hooks[0].command).toContain('kizami save');
  });

  it('should replace existing kizami hooks on re-run', async () => {
    // Run setup twice
    await setupHooks(setupOptions());
    await setupHooks(setupOptions());

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    // Should still have only one kizami hook per event
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('should initialize the database', async () => {
    await setupHooks(setupOptions());

    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('should install Codex hooks when target is codex', async () => {
    await setupHooks({ ...setupOptions(), target: 'codex', codexHooksPath });

    const settings = JSON.parse(fs.readFileSync(codexHooksPath, 'utf-8'));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('--runtime codex');
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('kizami recall');
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('kizami save');
  });

  it('should replace existing Kizami Codex hooks while preserving others', async () => {
    fs.mkdirSync(path.dirname(codexHooksPath), { recursive: true });
    fs.writeFileSync(
      codexHooksPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'other recall' }] },
            { hooks: [{ type: 'command', command: 'kizami recall --stdin # kizami-managed' }] },
          ],
        },
      }),
      'utf-8'
    );

    await setupHooks({ ...setupOptions(), target: 'codex', codexHooksPath });

    const settings = JSON.parse(fs.readFileSync(codexHooksPath, 'utf-8'));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe('other recall');
    expect(settings.hooks.UserPromptSubmit[1].hooks[0].command).toContain('--runtime codex');
  });

  it('should not remove user-defined non-managed Kizami hooks', async () => {
    fs.mkdirSync(path.dirname(codexHooksPath), { recursive: true });
    fs.writeFileSync(
      codexHooksPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'kizami search project-notes' }] },
            { hooks: [{ type: 'command', command: 'kizami recall --stdin' }] },
          ],
        },
      }),
      'utf-8'
    );

    await setupHooks({ ...setupOptions(), target: 'codex', codexHooksPath });

    const settings = JSON.parse(fs.readFileSync(codexHooksPath, 'utf-8'));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(3);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe('kizami search project-notes');
    expect(settings.hooks.UserPromptSubmit[1].hooks[0].command).toBe('kizami recall --stdin');
    expect(settings.hooks.UserPromptSubmit[2].hooks[0].command).toContain('# kizami-managed');
  });

  it('should write kimi hooks to config.toml with BEGIN/END markers', async () => {
    const kimiConfigPath = path.join(tmpDir, '.kimi-code', 'config.toml');
    await setupHooks({ ...setupOptions(), target: 'kimi', kimiConfigPath });

    expect(fs.existsSync(kimiConfigPath)).toBe(true);
    const content = fs.readFileSync(kimiConfigPath, 'utf-8');
    expect(content).toContain('# BEGIN kizami-managed');
    expect(content).toContain('# END kizami-managed');
    expect(content).toContain('event = "SessionStart"');
    expect(content).toContain('event = "UserPromptSubmit"');
    expect(content).toContain('--runtime kimi');
  });

  it('should replace kimi hooks on re-run without duplication', async () => {
    const kimiConfigPath = path.join(tmpDir, '.kimi-code', 'config.toml');
    await setupHooks({ ...setupOptions(), target: 'kimi', kimiConfigPath });
    await setupHooks({ ...setupOptions(), target: 'kimi', kimiConfigPath });

    const content = fs.readFileSync(kimiConfigPath, 'utf-8');
    const beginCount = content.split('# BEGIN kizami-managed').length - 1;
    expect(beginCount).toBe(1);
  });

  it('should preserve existing non-kizami content in config.toml', async () => {
    const kimiConfigPath = path.join(tmpDir, '.kimi-code', 'config.toml');
    fs.mkdirSync(path.dirname(kimiConfigPath), { recursive: true });
    fs.writeFileSync(kimiConfigPath, '[[hooks]]\nevent = "PreToolUse"\ncommand = "user-hook"\n');

    await setupHooks({ ...setupOptions(), target: 'kimi', kimiConfigPath });

    const content = fs.readFileSync(kimiConfigPath, 'utf-8');
    expect(content).toContain('command = "user-hook"');
    expect(content).toContain('# BEGIN kizami-managed');
  });

  it('should report kimi status with correct hookCount', async () => {
    const kimiConfigPath = path.join(tmpDir, '.kimi-code', 'config.toml');
    await setupHooks({ ...setupOptions(), target: 'kimi', kimiConfigPath });

    const status = getSetupStatus({ target: 'kimi', kimiConfigPath });
    expect(status).toHaveLength(1);
    expect(status[0].target).toBe('kimi');
    expect(status[0].hookCount).toBe(2);
    expect(status[0].installed).toBe(true);
  });

  it('should uninstall kimi hooks from config.toml', async () => {
    const kimiConfigPath = path.join(tmpDir, '.kimi-code', 'config.toml');
    await setupHooks({ ...setupOptions(), target: 'kimi', kimiConfigPath });
    const result = uninstallHooks({ target: 'kimi', kimiConfigPath });

    const kimiStatus = result.find((s) => s.target === 'kimi');
    expect(kimiStatus?.removed).toBe(true);
    expect(kimiStatus?.hookCount).toBe(0);

    const content = fs.readFileSync(kimiConfigPath, 'utf-8');
    expect(content).not.toContain('# BEGIN kizami-managed');
  });

  it('should setup all targets including kimi', async () => {
    const kimiConfigPath = path.join(tmpDir, '.kimi-code', 'config.toml');
    await setupHooks({ ...setupOptions(), target: 'all', codexHooksPath, kimiConfigPath });

    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(fs.existsSync(codexHooksPath)).toBe(true);
    expect(fs.existsSync(kimiConfigPath)).toBe(true);
  });

  it('should report read-only Codex config sources as not removed on uninstall', () => {
    const oldCwd = process.cwd();
    process.chdir(tmpDir);
    const codexConfigPath = path.join(tmpDir, '.codex', 'config.toml');
    try {
      fs.mkdirSync(path.dirname(codexHooksPath), { recursive: true });
      fs.writeFileSync(
        codexHooksPath,
        JSON.stringify({
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'kizami save --stdin # kizami-managed' }] },
            ],
          },
        }),
        'utf-8'
      );
      fs.writeFileSync(
        codexConfigPath,
        '[[hooks.Stop]]\ncommand = "kizami save --stdin # kizami-managed"\n',
        'utf-8'
      );

      const status = uninstallHooks({ target: 'codex', scope: 'project' });
      const hooksJson = status.find((s) => s.writable);
      const configToml = status.find((s) => !s.writable);

      expect(hooksJson?.removed).toBe(true);
      expect(configToml?.removed).toBe(false);
    } finally {
      process.chdir(oldCwd);
    }
  });
});
