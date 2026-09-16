import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  loadConfig,
  getDefaultConfig,
  getDefaultDbPath,
  getConfigFilePath,
  applyProjectAlias,
  validateProjectAliases,
} from '../src/config';

describe('config', () => {
  it('should return default config', () => {
    const config = getDefaultConfig();
    expect(config.search.mode).toBe('core');
    expect(config.search.timeDecayHalfLifeDays).toBe(30);
    expect(config.search.defaultLimit).toBe(5);
    expect(config.search.projectScope).toBe(true);
    expect(config.storage.projectAliases).toEqual({});
    expect(config.chunking.maxTokensPerChunk).toBe(512);
    expect(config.hooks.autoRecall).toBe(true);
    expect(config.hooks.recallLimit).toBe(3);
    expect(config.hooks.minRelevanceScore).toBe(0);
  });

  it('should resolve default db path under XDG_DATA_HOME', () => {
    const dbPath = getDefaultDbPath();
    expect(dbPath).toContain('kizami');
    expect(dbPath).toContain('memory.db');
  });

  it('should resolve config file path under XDG_CONFIG_HOME', () => {
    const configPath = getConfigFilePath();
    expect(configPath).toContain('kizami');
    expect(configPath).toContain('config.json');
  });

  it('should load config from file and merge with defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-test-'));
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

  describe('validateConfig', () => {
    it('should accept valid projectScope values', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-test-'));

      for (const value of [true, false, 'tiered']) {
        const configPath = path.join(tmpDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({ search: { projectScope: value } }));
        const config = loadConfig(configPath);
        expect(config.search.projectScope).toBe(value);
      }

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should fallback to true for invalid projectScope', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-test-'));
      const configPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ search: { projectScope: 'tierd' } }));

      const config = loadConfig(configPath);
      expect(config.search.projectScope).toBe(true);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should clamp crossProjectPenalty to 0-1 range', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-test-'));
      const configPath = path.join(tmpDir, 'config.json');

      fs.writeFileSync(configPath, JSON.stringify({ search: { crossProjectPenalty: -0.5 } }));
      expect(loadConfig(configPath).search.crossProjectPenalty).toBe(0);

      fs.writeFileSync(configPath, JSON.stringify({ search: { crossProjectPenalty: 2.0 } }));
      expect(loadConfig(configPath).search.crossProjectPenalty).toBe(1);

      fs.writeFileSync(configPath, JSON.stringify({ search: { crossProjectPenalty: 0.7 } }));
      expect(loadConfig(configPath).search.crossProjectPenalty).toBe(0.7);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should default projectAliases to {} when malformed', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-test-'));
      const configPath = path.join(tmpDir, 'config.json');

      fs.writeFileSync(
        configPath,
        JSON.stringify({ storage: { projectAliases: 'not-an-object' } })
      );
      expect(loadConfig(configPath).storage.projectAliases).toEqual({});

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should drop non-string values from projectAliases', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-test-'));
      const configPath = path.join(tmpDir, 'config.json');

      fs.writeFileSync(
        configPath,
        JSON.stringify({ storage: { projectAliases: { '/x/proj': 42, '/y/proj': '/z/proj' } } })
      );
      expect(loadConfig(configPath).storage.projectAliases).toEqual({ '/y/proj': '/z/proj' });

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should strip trailing separators from projectAliases keys and values', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-test-'));
      const configPath = path.join(tmpDir, 'config.json');

      fs.writeFileSync(
        configPath,
        JSON.stringify({ storage: { projectAliases: { '/x/proj/': '/y/proj/' } } })
      );
      expect(loadConfig(configPath).storage.projectAliases).toEqual({ '/x/proj': '/y/proj' });

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should strip multiple trailing separators from projectAliases keys and values', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-test-'));
      const configPath = path.join(tmpDir, 'config.json');

      fs.writeFileSync(
        configPath,
        JSON.stringify({ storage: { projectAliases: { '/x/proj//': '/y/proj//' } } })
      );
      expect(loadConfig(configPath).storage.projectAliases).toEqual({ '/x/proj': '/y/proj' });

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should default projectAliases to {} for a null value', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-test-'));
      const configPath = path.join(tmpDir, 'config.json');

      fs.writeFileSync(configPath, JSON.stringify({ storage: { projectAliases: null } }));
      expect(loadConfig(configPath).storage.projectAliases).toEqual({});

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('validateProjectAliases should return {} for null directly', () => {
      expect(validateProjectAliases(null)).toEqual({});
    });

    it('should drop entries with an empty key or empty value', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-test-'));
      const configPath = path.join(tmpDir, 'config.json');

      fs.writeFileSync(
        configPath,
        JSON.stringify({
          storage: {
            projectAliases: { '': '/z/proj', '/x/proj': '', '/y/proj': '/w/proj' },
          },
        })
      );
      expect(loadConfig(configPath).storage.projectAliases).toEqual({ '/y/proj': '/w/proj' });

      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('applyProjectAlias', () => {
    it('should return the path unchanged when no alias matches', () => {
      expect(applyProjectAlias({}, '/Users/me/proj')).toBe('/Users/me/proj');
      expect(applyProjectAlias({ '/x/proj': '/y/proj' }, '/other/path')).toBe('/other/path');
    });

    it('should map an exact key match', () => {
      expect(applyProjectAlias({ '/x/proj': '/y/proj' }, '/x/proj')).toBe('/y/proj');
    });

    it('should map a subdirectory of a key', () => {
      expect(applyProjectAlias({ '/x/proj': '/y/proj' }, '/x/proj/sub')).toBe('/y/proj/sub');
    });

    it('should not treat a sibling with a shared prefix as a match', () => {
      expect(applyProjectAlias({ '/x/proj': '/y/proj' }, '/x/proj-other')).toBe('/x/proj-other');
    });

    it('should pick the longest matching key', () => {
      const aliases = { '/x': '/A', '/x/proj': '/B' };
      expect(applyProjectAlias(aliases, '/x/proj/sub')).toBe('/B/sub');
      expect(applyProjectAlias(aliases, '/x/other')).toBe('/A/other');
    });

    it('should pick the longest matching key regardless of insertion order', () => {
      const aliases = { '/x/proj': '/B', '/x': '/A' };
      expect(applyProjectAlias(aliases, '/x/proj/sub')).toBe('/B/sub');
    });

    it('should convert the subdirectory separator to match the value side', () => {
      const aliases = { 'C:\\Users\\me\\proj': '/Users/me/proj' };
      expect(applyProjectAlias(aliases, 'C:\\Users\\me\\proj\\sub\\dir')).toBe(
        '/Users/me/proj/sub/dir'
      );
      expect(applyProjectAlias(aliases, 'C:\\Users\\me\\proj')).toBe('/Users/me/proj');
    });

    it('should convert the subdirectory separator to backslash when the value is a Windows path', () => {
      const aliases = { '/x/proj': 'C:\\Users\\me\\proj' };
      expect(applyProjectAlias(aliases, '/x/proj/sub/dir')).toBe('C:\\Users\\me\\proj\\sub\\dir');
    });
  });
});
