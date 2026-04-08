import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { getDefaultDbPath, getConfigFilePath, getDefaultConfig } from '@/config';
import { Store } from '@/db/store';

interface HookEntry {
  type: string;
  command: string;
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
}

function getDefaultSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
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
  return hook.command.includes('kizami ');
}

function mergeHooks(existing: HookMatcher[] | undefined, newMatcher: HookMatcher): HookMatcher[] {
  if (!existing) return [newMatcher];
  const filtered = existing.filter((matcher) => !matcher.hooks.some((h) => isEngramHook(h)));
  return [...filtered, newMatcher];
}

function writeEngramConfig(mode: 'core' | 'hybrid'): void {
  const configPath = getConfigFilePath();
  const defaults = getDefaultConfig();
  defaults.search.mode = mode;

  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true });

  // 既存設定があればmodeだけ更新
  let config: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 新規作成
  }

  if (!config['search']) {
    config['search'] = {};
  }
  (config['search'] as Record<string, unknown>)['mode'] = mode;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`  Config: ${configPath} (mode: ${mode})`);
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

export async function setupHooks(options?: SetupOptions): Promise<void> {
  const settingsPath = options?.settingsPath ?? getDefaultSettingsPath();
  const settings = readSettings(settingsPath);
  const hybrid = options?.hybrid ?? false;

  const errorLogPath = path.join(
    process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share'),
    'kizami',
    'error.log'
  );

  const saveHook: HookMatcher = {
    hooks: [
      {
        type: 'command',
        command: `bash -c 'trap "" INT TERM; kizami save --stdin 2>> ${errorLogPath}'`,
      },
    ],
  };

  const recallHook: HookMatcher = {
    hooks: [
      {
        type: 'command',
        command: 'kizami recall --stdin',
      },
    ],
  };

  if (!settings.hooks) {
    settings.hooks = {};
  }

  settings.hooks['SessionEnd'] = mergeHooks(settings.hooks['SessionEnd'], saveHook);
  settings.hooks['UserPromptSubmit'] = mergeHooks(settings.hooks['UserPromptSubmit'], recallHook);

  writeSettings(settingsPath, settings);

  // Initialize database
  const dbPath = options?.dbPath ?? getDefaultDbPath();
  const db = getDatabase(dbPath);
  try {
    initializeSchema(db);

    // Write kizami config
    writeEngramConfig(hybrid ? 'hybrid' : 'core');

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
  console.log(`  Settings: ${settingsPath}`);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Error log: ${errorLogPath}`);
}
