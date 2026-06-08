import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { getConfigFilePath, getDefaultConfig } from '@/config';
import { loadConfig } from '@/config';
import { Store } from '@/db/store';
import { ensureJsonlDir } from '@/jsonl/path';
import {
  writeKizamiTomlHooks,
  removeKizamiTomlHooksFromFile,
  countKizamiTomlHooks,
  hasKizamiTomlBlock,
} from '@/hooks/toml';
import type { TomlHook } from '@/hooks/toml';

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface HookMatcher {
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

export interface SetupOptions {
  settingsPath?: string;
  dbPath?: string;
  hybrid?: boolean;
  target?: SetupTarget;
  scope?: SetupScope;
  codexHooksPath?: string;
  kimiConfigPath?: string;
  configPath?: string;
  jsonlDir?: string;
  binPath?: string;
}

export type SetupTarget = 'claude' | 'codex' | 'kimi' | 'all';
export type SetupScope = 'user' | 'project';

export interface SetupStatus {
  target: 'claude' | 'codex' | 'kimi';
  path: string;
  installed: boolean;
  hookCount: number;
  writable: boolean;
  removed?: boolean;
}

function getDefaultSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getDefaultCodexHooksPath(scope: SetupScope): string {
  if (scope === 'project') {
    return path.join(process.cwd(), '.codex', 'hooks.json');
  }
  return path.join(os.homedir(), '.codex', 'hooks.json');
}

function getDefaultCodexConfigPath(scope: SetupScope): string {
  if (scope === 'project') {
    return path.join(process.cwd(), '.codex', 'config.toml');
  }
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function readSettings(settingsPath: string): ClaudeSettings {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    return {};
  }
}

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function isEngramHook(hook: HookEntry): boolean {
  return hook.command.includes('# kizami-managed');
}

function mergeHooks(existing: HookMatcher[] | undefined, newMatcher: HookMatcher): HookMatcher[] {
  if (!existing) return [newMatcher];
  const cleaned = existing
    .map((matcher) => ({
      ...matcher,
      hooks: matcher.hooks.filter((h) => !isEngramHook(h)),
    }))
    .filter((matcher) => matcher.hooks.length > 0);
  return [...cleaned, newMatcher];
}

function writeEngramConfig(mode: 'core' | 'hybrid', configPath?: string): void {
  const filePath = configPath ?? getConfigFilePath();
  const defaults = getDefaultConfig();
  defaults.search.mode = mode;

  const configDir = path.dirname(filePath);
  fs.mkdirSync(configDir, { recursive: true });

  // 既存設定があればmodeだけ更新
  let config: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 新規作成
  }

  if (!config['search']) {
    config['search'] = {};
  }
  (config['search'] as Record<string, unknown>)['mode'] = mode;

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`  Config: ${filePath} (mode: ${mode})`);
}

function checkHybridDependencies(): { available: boolean; missing: string[] } {
  const esmRequire = createRequire(import.meta.url);
  const missing: string[] = [];
  try {
    esmRequire.resolve('sqlite-vec');
  } catch {
    missing.push('sqlite-vec');
  }
  try {
    esmRequire.resolve('@huggingface/transformers');
  } catch {
    missing.push('@huggingface/transformers');
  }
  return { available: missing.length === 0, missing };
}

function createHook(command: string, timeout?: number): HookMatcher {
  return {
    hooks: [
      {
        type: 'command',
        command,
        ...(timeout ? { timeout } : {}),
      } as HookEntry,
    ],
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getKizamiCommand(options?: SetupOptions): string {
  if (options?.binPath) {
    return shellQuote(options.binPath);
  }
  const entrypoint = process.argv[1];
  if (entrypoint && path.basename(entrypoint) === 'cli.js' && fs.existsSync(entrypoint)) {
    return `${shellQuote(process.execPath)} ${shellQuote(entrypoint)}`;
  }
  return 'kizami';
}

function setupClaudeHooks(options?: SetupOptions): void {
  const settingsPath = options?.settingsPath ?? getDefaultSettingsPath();
  const settings = readSettings(settingsPath);
  const kizamiCommand = getKizamiCommand(options);

  const errorLogPath = path.join(
    process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share'),
    'kizami',
    'error.log'
  );
  const escapedErrorLogPath = errorLogPath.replace(/'/g, "'\\''");

  // SessionEnd hook は /quit 時に Claude Code 本体が hook の完了を待たず
  // "Hook cancelled" と表示することがある (Claude Code 2.x で確認)。
  // stdin を一度読み切ってから subshell に background で逃がし、
  // ラッパー bash 自体は即 exit 0 することでハーネスに完了を返す。
  const saveHook: HookMatcher = {
    hooks: [
      {
        type: 'command',
        command: `bash -c 'INPUT=$(cat); (printf "%s" "$INPUT" | ${kizamiCommand} save --stdin --runtime claude >/dev/null 2>> "${escapedErrorLogPath}" &); exit 0' # kizami-managed`,
      },
    ],
  };

  const recallHook: HookMatcher = {
    hooks: [
      {
        type: 'command',
        command: `${kizamiCommand} recall --stdin --runtime claude # kizami-managed`,
      },
    ],
  };

  // SessionStart hook (v0.2.0+): セッション開始時にプロジェクト直近Q&Aを冒頭注入する。
  // Claude Code v2.1.0+ で SessionStart hook がサポートされている（実証根拠: 設計書 §3.6）。
  const injectHook: HookMatcher = {
    hooks: [
      {
        type: 'command',
        command: `${kizamiCommand} inject --stdin --runtime claude # kizami-managed`,
      },
    ],
  };

  if (!settings.hooks) {
    settings.hooks = {};
  }

  settings.hooks['SessionEnd'] = mergeHooks(settings.hooks['SessionEnd'], saveHook);
  settings.hooks['UserPromptSubmit'] = mergeHooks(settings.hooks['UserPromptSubmit'], recallHook);
  settings.hooks['SessionStart'] = mergeHooks(settings.hooks['SessionStart'], injectHook);

  writeSettings(settingsPath, settings);
}

function setupCodexHooks(options?: SetupOptions): void {
  const scope = options?.scope ?? 'user';
  const hooksPath = options?.codexHooksPath ?? getDefaultCodexHooksPath(scope);
  const settings = readSettings(hooksPath);
  const kizamiCommand = getKizamiCommand(options);

  if (!settings.hooks) {
    settings.hooks = {};
  }

  settings.hooks['SessionStart'] = mergeHooks(
    settings.hooks['SessionStart'],
    createHook(`${kizamiCommand} inject --stdin --runtime codex # kizami-managed`, 5)
  );
  settings.hooks['UserPromptSubmit'] = mergeHooks(
    settings.hooks['UserPromptSubmit'],
    createHook(`${kizamiCommand} recall --stdin --runtime codex # kizami-managed`, 5)
  );
  settings.hooks['Stop'] = mergeHooks(
    settings.hooks['Stop'],
    createHook(`${kizamiCommand} save --stdin --runtime codex # kizami-managed`, 5)
  );

  writeSettings(hooksPath, settings);
}

function getDefaultKimiConfigPath(scope: SetupScope): string {
  if (scope === 'project') {
    return path.join(process.cwd(), '.kimi-code', 'config.toml');
  }
  const kimiHome = process.env['KIMI_CODE_HOME'] || path.join(os.homedir(), '.kimi-code');
  return path.join(kimiHome, 'config.toml');
}

function setupKimiHooks(options?: SetupOptions): void {
  const scope = options?.scope ?? 'user';
  const kimiConfigPath = options?.kimiConfigPath ?? getDefaultKimiConfigPath(scope);
  const kizamiCommand = getKizamiCommand(options);

  const errorLogPath = path.join(
    process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share'),
    'kizami',
    'error.log'
  );
  const escapedErrorLogPath = errorLogPath.replace(/'/g, "'\\''");
  const escapedKizamiCommand = kizamiCommand.replace(/'/g, "'\\''");

  const hooks: TomlHook[] = [
    {
      event: 'SessionStart',
      command: `${kizamiCommand} inject --stdin --runtime kimi`,
      timeout: 5,
    },
    {
      event: 'UserPromptSubmit',
      command: `${kizamiCommand} recall --stdin --runtime kimi`,
      timeout: 5,
    },
    {
      event: 'SessionEnd',
      command: `bash -c 'INPUT=$(cat); (printf "%s" "$INPUT" | ${escapedKizamiCommand} save --stdin --runtime kimi >/dev/null 2>> "${escapedErrorLogPath}" &); exit 0'`,
    },
  ];

  writeKizamiTomlHooks(kimiConfigPath, hooks);
}

function initializeKizamiStorage(options?: SetupOptions): void {
  const hybrid = options?.hybrid ?? false;
  writeEngramConfig(hybrid ? 'hybrid' : 'core', options?.configPath);
  let config = loadConfig(options?.configPath);
  if (options?.dbPath) {
    config = { ...config, database: { path: options.dbPath } };
  }
  if (options?.jsonlDir) {
    config = { ...config, storage: { ...config.storage, jsonlDir: options.jsonlDir } };
  }
  const errorLogPath = path.join(
    process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share'),
    'kizami',
    'error.log'
  );

  // Initialize database
  const dbPath = config.database.path;
  const db = getDatabase(dbPath);

  // JSONL正本ディレクトリを準備（v0.2.0〜）
  const jsonlDir = config.storage.jsonlDir;
  ensureJsonlDir(jsonlDir);

  // 既存ユーザー向けマイグレーション案内
  try {
    const store = new Store(db);
    initializeSchema(db);
    const hasLegacyChunks = store.getStats().totalChunks > 0;
    if (hasLegacyChunks) {
      // jsonlDir が空ならまだ移行されていない
      const files = fs.readdirSync(jsonlDir).filter((f) => f.endsWith('.jsonl'));
      if (files.length === 0) {
        console.log('');
        console.log('[kizami] v0.2.0からはJSONLが正本になりました。');
        console.log('[kizami] 既存のSQLiteデータをJSONLに移行するには:');
        console.log('[kizami]   $ kizami migrate-to-jsonl');
        console.log(
          '[kizami] 未移行のまま使用してもデータロスはありませんが、自動復旧/Git同期が無効化されます。'
        );
        console.log('');
      }
    }
  } catch {
    // 案内表示の失敗は無視
  }

  try {
    initializeSchema(db);

    // Hybrid mode dependency check
    if (hybrid) {
      const deps = checkHybridDependencies();
      if (!deps.available) {
        console.log(
          `  Warning: hybridモードに必要なパッケージがありません: ${deps.missing.join(', ')}`
        );
        console.log(`  以下を実行してください: npm install -g ${deps.missing.join(' ')}`);
      } else {
        console.log('  Hybrid dependencies: OK');

        // Check for chunks without embeddings
        const store = new Store(db);
        const missingCount = store.getChunkIdsWithoutEmbedding().length;
        if (missingCount > 0) {
          console.log(
            `  Note: ${missingCount} chunks need embeddings. Run: kizami embed --backfill`
          );
        }
      }
    }
  } finally {
    db.close();
  }

  console.log('kizami hooks installed successfully.');
  console.log(`  Database: ${dbPath}`);
  console.log(`  JSONL dir: ${jsonlDir}`);
  console.log(`  Error log: ${errorLogPath}`);
}

export async function setupHooks(options?: SetupOptions): Promise<void> {
  const target = options?.target ?? 'claude';

  if (target === 'claude' || target === 'all') {
    setupClaudeHooks(options);
    console.log(`  Claude settings: ${options?.settingsPath ?? getDefaultSettingsPath()}`);
  }
  if (target === 'codex' || target === 'all') {
    setupCodexHooks(options);
    const codexPath = options?.codexHooksPath ?? getDefaultCodexHooksPath(options?.scope ?? 'user');
    console.log(`  Codex hooks: ${codexPath}`);
    console.log('  Codex note: run /hooks in Codex to review and trust the new hook definitions.');
  }
  if (target === 'kimi' || target === 'all') {
    setupKimiHooks(options);
    const kimiPath = options?.kimiConfigPath ?? getDefaultKimiConfigPath(options?.scope ?? 'user');
    console.log(`  Kimi config: ${kimiPath}`);
  }

  initializeKizamiStorage(options);
}

function countKizamiHooks(settings: ClaudeSettings): number {
  let count = 0;
  for (const matchers of Object.values(settings.hooks ?? {})) {
    for (const matcher of matchers) {
      count += matcher.hooks.filter((h) => isEngramHook(h)).length;
    }
  }
  return count;
}

function countManagedMarkersInFile(filePath: string): number {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return (raw.match(/# kizami-managed/g) ?? []).length;
  } catch {
    return 0;
  }
}

function isWritableHooksJson(filePath: string): boolean {
  return path.basename(filePath) === 'hooks.json';
}

export function getSetupStatus(options?: SetupOptions): SetupStatus[] {
  const target = options?.target ?? 'all';
  const results: SetupStatus[] = [];

  if (target === 'claude' || target === 'all') {
    const settingsPath = options?.settingsPath ?? getDefaultSettingsPath();
    const settings = readSettings(settingsPath);
    const hookCount = countKizamiHooks(settings);
    results.push({
      target: 'claude',
      path: settingsPath,
      installed: hookCount > 0,
      hookCount,
      writable: true,
      removed: false,
    });
  }
  if (target === 'codex' || target === 'all') {
    const scope = options?.scope;
    const paths = options?.codexHooksPath
      ? [options.codexHooksPath]
      : [
          ...(scope == null || scope === 'user'
            ? [getDefaultCodexHooksPath('user'), getDefaultCodexConfigPath('user')]
            : []),
          ...(scope == null || scope === 'project'
            ? [getDefaultCodexHooksPath('project'), getDefaultCodexConfigPath('project')]
            : []),
        ];
    for (const codexPath of paths) {
      const hookCount = isWritableHooksJson(codexPath)
        ? countKizamiHooks(readSettings(codexPath))
        : countManagedMarkersInFile(codexPath);
      results.push({
        target: 'codex',
        path: codexPath,
        installed: hookCount > 0,
        hookCount,
        writable: isWritableHooksJson(codexPath),
        removed: false,
      });
    }
  }

  if (target === 'kimi' || target === 'all') {
    const scope = options?.scope;
    const kimiPaths = options?.kimiConfigPath
      ? [options.kimiConfigPath]
      : [
          ...(scope == null || scope === 'user' ? [getDefaultKimiConfigPath('user')] : []),
          ...(scope == null || scope === 'project' ? [getDefaultKimiConfigPath('project')] : []),
        ];
    for (const kimiPath of kimiPaths) {
      let hookCount = 0;
      try {
        const content = fs.readFileSync(kimiPath, 'utf-8');
        hookCount = countKizamiTomlHooks(content);
      } catch {
        /* file does not exist */
      }
      results.push({
        target: 'kimi',
        path: kimiPath,
        installed: hookCount > 0,
        hookCount,
        writable: true,
      });
    }
  }

  return results;
}

function removeKizamiHooks(settings: ClaudeSettings): ClaudeSettings {
  if (!settings.hooks) return settings;
  const cleaned: Record<string, HookMatcher[]> = {};
  for (const event of Object.keys(settings.hooks)) {
    cleaned[event] = settings.hooks[event]
      .map((matcher) => ({
        ...matcher,
        hooks: matcher.hooks.filter((h) => !isEngramHook(h)),
      }))
      .filter((matcher) => matcher.hooks.length > 0);
  }
  return { ...settings, hooks: cleaned };
}

export function uninstallHooks(options?: SetupOptions): SetupStatus[] {
  const target = options?.target ?? 'all';
  const removedPaths = new Set<string>();

  if (target === 'claude' || target === 'all') {
    const settingsPath = options?.settingsPath ?? getDefaultSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const before = readSettings(settingsPath);
      const beforeCount = countKizamiHooks(before);
      if (beforeCount > 0) {
        const after = removeKizamiHooks(before);
        writeSettings(settingsPath, after);
        removedPaths.add(settingsPath);
      }
    }
  }
  if (target === 'codex' || target === 'all') {
    const scope = options?.scope;
    const paths = options?.codexHooksPath
      ? [options.codexHooksPath]
      : [
          ...(scope == null || scope === 'user' ? [getDefaultCodexHooksPath('user')] : []),
          ...(scope == null || scope === 'project' ? [getDefaultCodexHooksPath('project')] : []),
        ];
    for (const hooksPath of paths) {
      if (!fs.existsSync(hooksPath)) continue;
      const before = readSettings(hooksPath);
      const beforeCount = countKizamiHooks(before);
      if (beforeCount > 0) {
        const after = removeKizamiHooks(before);
        writeSettings(hooksPath, after);
        removedPaths.add(hooksPath);
      }
    }
  }

  if (target === 'kimi' || target === 'all') {
    const scope = options?.scope;
    const kimiPaths = options?.kimiConfigPath
      ? [options.kimiConfigPath]
      : [
          ...(scope == null || scope === 'user' ? [getDefaultKimiConfigPath('user')] : []),
          ...(scope == null || scope === 'project' ? [getDefaultKimiConfigPath('project')] : []),
        ];
    for (const kimiPath of kimiPaths) {
      try {
        const content = fs.readFileSync(kimiPath, 'utf-8');
        if (hasKizamiTomlBlock(content)) {
          removeKizamiTomlHooksFromFile(kimiPath);
          removedPaths.add(kimiPath);
        }
      } catch {
        /* file does not exist */
      }
    }
  }

  return getSetupStatus(options).map((status) => ({
    ...status,
    removed: removedPaths.has(status.path),
  }));
}
