import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { setupHooks, uninstallHooks, getSetupStatus } from '../../src/hooks/setup';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';
import { Store } from '../../src/db/store';

// worker スレッドでは process.env.HOME を変えても os.homedir() に届かない。
// 既定パスが実ホームを指さないよう、homedir() を process.env.HOME に従わせる。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => process.env['HOME'] ?? actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

describe('setupHooks', () => {
  let tmpDir: string;
  let settingsPath: string;
  let codexHooksPath: string;
  let dbPath: string;
  let configPath: string;
  let kimiConfigPath: string;
  let jsonlDir: string;
  // パスを渡し忘れたテストが実際の ~/.codex や ~/.kimi-code を書き換えないよう、
  // setup が既定パスの算出に使う環境変数をすべて一時ディレクトリへ向ける。
  const ISOLATED_ENV = ['HOME', 'KIMI_CODE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'] as const;
  const savedEnv: Partial<Record<(typeof ISOLATED_ENV)[number], string | undefined>> = {};

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-setup-')));
    // --scope project の既定パスは cwd 基準なので、リポジトリ直下に書かせない。
    // Stryker の worker では process.chdir() が使えないため cwd を差し替える。
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    for (const key of ISOLATED_ENV) {
      savedEnv[key] = process.env[key];
      process.env[key] = path.join(tmpDir, `env-${key}`);
    }
    settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    codexHooksPath = path.join(tmpDir, '.codex', 'hooks.json');
    kimiConfigPath = path.join(tmpDir, '.kimi-code', 'config.toml');
    dbPath = path.join(tmpDir, 'kizami', 'memory.db');
    configPath = path.join(tmpDir, 'kizami', 'config.json');
    jsonlDir = path.join(tmpDir, 'kizami', 'jsonl');
  });

  afterEach(() => {
    for (const key of ISOLATED_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupOptions() {
    return {
      settingsPath,
      codexHooksPath,
      kimiConfigPath,
      dbPath,
      configPath,
      jsonlDir,
      binPath: 'kizami',
    };
  }

  it('resolves every default config path inside the test directory', () => {
    const paths = getSetupStatus({ target: 'all' }).map((s) => s.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => !p.startsWith(tmpDir + path.sep))).toEqual([]);
  });

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

  const skillFile = () => path.join(tmpDir, '.claude', 'skills', 'kizami-recall', 'SKILL.md');

  it('installs the recall skill next to settings.json with the kizami command', async () => {
    await setupHooks(setupOptions());
    expect(fs.readFileSync(skillFile(), 'utf-8')).toContain('allowed-tools: Bash(kizami search:*)');
  });

  it('works without options, using default paths under HOME', async () => {
    const home = process.env['HOME'] as string;
    await setupHooks();
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'kizami-recall', 'SKILL.md'))).toBe(
      true
    );
  });

  function putPastSession(id: string): void {
    const dir = path.join(process.env['HOME'] as string, '.claude', 'projects', '-w-proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '../fixtures/sample-transcript.jsonl'),
      path.join(dir, `${id}.jsonl`)
    );
  }

  function storedSessionIds(): string[] {
    const dbFile = path.join(process.env['XDG_DATA_HOME'] as string, 'kizami', 'memory.db');
    const db = getDatabase(dbFile);
    try {
      initializeSchema(db);
      return new Store(db).getSessionList().map((s) => s.sessionId);
    } finally {
      db.close();
    }
  }

  it.each([{ recallOnly: false }, { recallOnly: true }, { target: 'all' as const }])(
    'imports existing Claude Code sessions on setup (%o)',
    async (extra) => {
      putPastSession('past-0001');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      await setupHooks({ ...setupOptions(), ...extra });

      expect(storedSessionIds()).toEqual(['past-0001']);
      expect(log).toHaveBeenCalledWith('  Imported past sessions: 1');
    }
  );

  it('does not import sessions for a codex-only setup', async () => {
    putPastSession('past-0002');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await setupHooks({ ...setupOptions(), target: 'codex' });

    expect(storedSessionIds()).toEqual([]);
  });

  it('prints the skill path, and the recall-only mode only when requested', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await setupHooks(setupOptions());
    expect(log).toHaveBeenCalledWith(`  Recall skill: ${skillFile()}`);
    expect(log).not.toHaveBeenCalledWith('  Mode: recall-only (no automatic injection)');

    log.mockClear();
    await setupHooks({ ...setupOptions(), recallOnly: true });
    expect(log).toHaveBeenCalledWith('  Mode: recall-only (no automatic injection)');
  });

  it('keeps foreign UserPromptSubmit and SessionStart hooks on a normal setup', async () => {
    const foreign = { hooks: [{ type: 'command', command: 'echo mine' }] };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { UserPromptSubmit: [foreign], SessionStart: [foreign] } })
    );

    await setupHooks(setupOptions());

    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.UserPromptSubmit[0]).toEqual(foreign);
    expect(s.hooks.UserPromptSubmit[1].hooks[0].command).toContain('kizami recall');
    expect(s.hooks.SessionStart[0]).toEqual(foreign);
    expect(s.hooks.SessionStart[1].hooks[0].command).toContain('kizami inject');
  });

  it('recallOnly keeps save hooks, drops injection hooks, and preserves foreign hooks', async () => {
    await setupHooks(setupOptions());
    const withForeign = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    withForeign.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'echo mine' }] });
    fs.writeFileSync(settingsPath, JSON.stringify(withForeign));

    await setupHooks({ ...setupOptions(), recallOnly: true });

    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.SessionEnd).toHaveLength(1);
    expect(s.hooks.SessionEnd[0].hooks[0].command).toContain('kizami save');
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.Stop[0].hooks[0].command).toContain('kizami save');
    expect(s.hooks.SessionStart).toBeUndefined();
    expect(s.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: 'echo mine' }] },
    ]);
    expect(fs.existsSync(skillFile())).toBe(true);
  });

  it('re-running setup without recallOnly restores the injection hooks', async () => {
    await setupHooks({ ...setupOptions(), recallOnly: true });
    await setupHooks(setupOptions());
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain('kizami recall');
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toContain('kizami inject');
  });

  it('recallOnly on a fresh settings file writes only save hooks', async () => {
    await setupHooks({ ...setupOptions(), recallOnly: true });
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(Object.keys(s.hooks).sort()).toEqual(['SessionEnd', 'Stop']);
  });

  it.each(['codex', 'kimi', 'all'] as const)('recallOnly rejects target %s', async (target) => {
    await expect(
      setupHooks({ ...setupOptions(), recallOnly: true, target, codexHooksPath, kimiConfigPath })
    ).rejects.toThrow('--recall-only supports only --target claude.');
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(fs.existsSync(codexHooksPath)).toBe(false);
    expect(fs.existsSync(kimiConfigPath)).toBe(false);
  });

  it('uninstall removes the recall skill', async () => {
    await setupHooks(setupOptions());
    uninstallHooks({ settingsPath, target: 'claude' });
    expect(fs.existsSync(path.dirname(skillFile()))).toBe(false);
  });

  it('uninstall of the codex target leaves the recall skill alone', async () => {
    await setupHooks(setupOptions());
    uninstallHooks({ settingsPath, target: 'codex', codexHooksPath });
    expect(fs.existsSync(skillFile())).toBe(true);
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
    expect(content).toContain('event = "SessionEnd"');
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
    expect(status[0].hookCount).toBe(3);
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
    const codexConfigPath = path.join(tmpDir, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(codexHooksPath), { recursive: true });
    fs.writeFileSync(
      codexHooksPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'kizami save --stdin # kizami-managed' }] }],
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
  });
});
