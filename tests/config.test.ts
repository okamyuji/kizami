import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { loadConfig, getDefaultConfig, getDefaultDbPath, getConfigFilePath } from '../src/config';

describe('config', () => {
  it('should return default config', () => {
    const config = getDefaultConfig();
    expect(config.search.mode).toBe('core');
    expect(config.search.timeDecayHalfLifeDays).toBe(30);
    expect(config.search.defaultLimit).toBe(5);
    expect(config.search.projectScope).toBe(true);
    expect(config.chunking.maxTokensPerChunk).toBe(512);
    expect(config.hooks.autoRecall).toBe(true);
    expect(config.hooks.recallLimit).toBe(3);
    expect(config.hooks.minRelevanceScore).toBe(0);
  });

  it('should resolve default db path under XDG_DATA_HOME', () => {
    const dbPath = getDefaultDbPath();
    expect(dbPath).toContain('engram');
    expect(dbPath).toContain('memory.db');
  });

  it('should resolve config file path under XDG_CONFIG_HOME', () => {
    const configPath = getConfigFilePath();
    expect(configPath).toContain('engram');
    expect(configPath).toContain('config.json');
  });

  it('should load config from file and merge with defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-test-'));
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        search: { defaultLimit: 10 },
      })
    );

    const config = loadConfig(configPath);
    expect(config.search.defaultLimit).toBe(10);
    // Other defaults should be preserved
    expect(config.search.mode).toBe('core');
    expect(config.hooks.autoRecall).toBe(true);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('should return defaults when config file does not exist', () => {
    const config = loadConfig('/nonexistent/path/config.json');
    expect(config).toEqual(getDefaultConfig());
  });
});
