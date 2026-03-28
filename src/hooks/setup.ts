import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';
import { getDefaultDbPath } from '../config';

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
  return hook.command.includes('engram ');
}

function mergeHooks(existing: HookMatcher[] | undefined, newMatcher: HookMatcher): HookMatcher[] {
  if (!existing) return [newMatcher];

  // Remove any existing engram hook matchers
  const filtered = existing.filter((matcher) => !matcher.hooks.some((h) => isEngramHook(h)));

  return [...filtered, newMatcher];
}

export async function setupHooks(options?: SetupOptions): Promise<void> {
  const settingsPath = options?.settingsPath ?? getDefaultSettingsPath();
  const settings = readSettings(settingsPath);

  const errorLogPath = path.join(
    process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share'),
    'engram',
    'error.log'
  );

  const saveHook: HookMatcher = {
    hooks: [
      {
        type: 'command',
        command: `engram save --stdin 2>> ${errorLogPath}`,
      },
    ],
  };

  const recallHook: HookMatcher = {
    hooks: [
      {
        type: 'command',
        command: 'engram recall --stdin --limit 3 --min-score 0.01',
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
  } finally {
    db.close();
  }

  console.log('engram hooks installed successfully.');
  console.log(`  Settings: ${settingsPath}`);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Error log: ${errorLogPath}`);
}
