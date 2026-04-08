import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

export interface EngramConfig {
  database: { path: string };
  search: {
    mode: 'core' | 'hybrid';
    timeDecayHalfLifeDays: number;
    defaultLimit: number;
    projectScope: boolean | 'tiered';
    crossProjectPenalty: number;
  };
  chunking: {
    maxTokensPerChunk: number;
    truncateToolOutputLines: number;
    truncateToolOutputTailLines: number;
  };
  hooks: {
    autoRecall: boolean;
    recallLimit: number;
    minRelevanceScore: number;
  };
  maintenance: {
    enabled: boolean;
    intervalHours: number;
    maxChunkAgeDays: number;
    maxDbSizeMB: number;
  };
  embedding: {
    model: string;
    quantized: boolean;
    dimensions: number;
    cacheDir: string;
  };
}

function getXdgDataHome(): string {
  return process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share');
}

function getXdgCacheHome(): string {
  return process.env['XDG_CACHE_HOME'] || path.join(os.homedir(), '.cache');
}

function getXdgConfigHome(): string {
  return process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
}

export function getDefaultDbPath(): string {
  return path.join(getXdgDataHome(), 'engram', 'memory.db');
}

export function getConfigFilePath(): string {
  return path.join(getXdgConfigHome(), 'engram', 'config.json');
}

export function getDefaultConfig(): EngramConfig {
  return {
    database: {
      path: getDefaultDbPath(),
    },
    search: {
      mode: 'core',
      timeDecayHalfLifeDays: 30,
      defaultLimit: 5,
      projectScope: true,
      crossProjectPenalty: 0.3,
    },
    chunking: {
      maxTokensPerChunk: 512,
      truncateToolOutputLines: 20,
      truncateToolOutputTailLines: 5,
    },
    hooks: {
      autoRecall: true,
      recallLimit: 3,
      minRelevanceScore: 0,
    },
    maintenance: {
      enabled: true,
      intervalHours: 24,
      maxChunkAgeDays: 90,
      maxDbSizeMB: 100,
    },
    embedding: {
      model: 'sirasagi62/ruri-v3-30m-ONNX',
      quantized: true,
      dimensions: 256,
      cacheDir: path.join(getXdgCacheHome(), 'engram', 'models'),
    },
  };
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overrideVal = override[key];
    if (
      baseVal &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal) &&
      overrideVal &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>
      );
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }
  return result;
}

function validateConfig(config: EngramConfig): EngramConfig {
  // projectScope: boolean | 'tiered' のみ許容、不正値はデフォルトにフォールバック
  const ps = config.search.projectScope;
  if (ps !== true && ps !== false && ps !== 'tiered') {
    config.search.projectScope = true;
  }

  // crossProjectPenalty: 0-1 にクランプ
  config.search.crossProjectPenalty = Math.max(0, Math.min(1, config.search.crossProjectPenalty));

  return config;
}

export function loadConfig(configPath?: string): EngramConfig {
  const defaults = getDefaultConfig();
  const filePath = configPath || getConfigFilePath();

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const userConfig = JSON.parse(raw) as Record<string, unknown>;
    const merged = deepMerge(
      defaults as unknown as Record<string, unknown>,
      userConfig
    ) as unknown as EngramConfig;
    return validateConfig(merged);
  } catch {
    return defaults;
  }
}
