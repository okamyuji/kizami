import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

export interface EngramConfig {
  database: { path: string };
  storage: {
    jsonlDir: string;
    selfHealTailLines: number;
    projectAliases: Record<string, string>;
  };
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
    injectRecentCount: number;
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
  return path.join(getXdgDataHome(), 'kizami', 'memory.db');
}

export function getDefaultJsonlDir(): string {
  return path.join(getXdgDataHome(), 'kizami', 'jsonl');
}

export function getConfigFilePath(): string {
  return path.join(getXdgConfigHome(), 'kizami', 'config.json');
}

export function getDefaultConfig(): EngramConfig {
  return {
    database: {
      path: getDefaultDbPath(),
    },
    storage: {
      jsonlDir: getDefaultJsonlDir(),
      selfHealTailLines: 100,
      projectAliases: {},
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
      injectRecentCount: 3,
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
      cacheDir: path.join(getXdgCacheHome(), 'kizami', 'models'),
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

function stripTrailingSeparator(value: string): string {
  return value.replace(/[/\\]+$/, '');
}

export function validateProjectAliases(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val !== 'string' || key.length === 0 || val.length === 0) continue;
    result[stripTrailingSeparator(key)] = stripTrailingSeparator(val);
  }
  return result;
}

/**
 * ホスト間で projectPath が異なる同一論理プロジェクトを紐付けるための対応表を適用する。
 * 最長一致のキーを、区切り文字境界を確認したうえで前方一致で探す
 * (`/x/proj` は `/x/proj/sub` に一致するが `/x/proj-other` には一致しない)。
 * サブパス部分の区切り文字は value 側の区切り文字に揃える。key と value がそれぞれ
 * 異なるOS由来のパス表記(`\` と `/`)になり得るため。
 */
export function applyProjectAlias(aliases: Record<string, string>, rawPath: string): string {
  let bestKey = '';
  for (const key of Object.keys(aliases)) {
    // Stryker disable next-line EqualityOperator: two distinct keys can never both be a
    // prefix-match of the same rawPath at equal length (a fixed-length prefix is unique),
    // so <= vs < is unobservable here.
    if (key.length <= bestKey.length) continue;
    if (rawPath === key || rawPath.startsWith(key + '/') || rawPath.startsWith(key + '\\')) {
      bestKey = key;
    }
  }
  if (!bestKey) return rawPath;

  const value = aliases[bestKey];
  const suffix = rawPath.slice(bestKey.length);
  if (suffix.length === 0) return value;
  const valueSep = value.includes('\\') ? '\\' : '/';
  const normalizedSuffix = suffix.slice(1).replace(/[/\\]/g, valueSep);
  return `${value}${valueSep}${normalizedSuffix}`;
}

function validateConfig(config: EngramConfig): EngramConfig {
  const ps = config.search.projectScope;
  const validProjectScope = ps === true || ps === false || ps === 'tiered' ? ps : true;
  const clampedPenalty = Math.max(0, Math.min(1, config.search.crossProjectPenalty));

  return {
    ...config,
    search: {
      ...config.search,
      projectScope: validProjectScope,
      crossProjectPenalty: clampedPenalty,
    },
    storage: {
      ...config.storage,
      projectAliases: validateProjectAliases(config.storage.projectAliases),
    },
  };
}

export function loadConfig(configPath?: string): EngramConfig {
  const defaults = getDefaultConfig();
  const filePath = configPath || getConfigFilePath();

  let resolved: EngramConfig;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const userConfig = JSON.parse(raw) as Record<string, unknown>;
    const merged = deepMerge(
      defaults as unknown as Record<string, unknown>,
      userConfig
    ) as unknown as EngramConfig;
    resolved = validateConfig(merged);
  } catch {
    resolved = defaults;
  }

  // 環境変数による override（テスト・コンテナ運用向け）
  const envJsonlDir = process.env['KIZAMI_JSONL_DIR'];
  if (envJsonlDir && envJsonlDir.length > 0) {
    resolved = { ...resolved, storage: { ...resolved.storage, jsonlDir: envJsonlDir } };
  }
  return resolved;
}
