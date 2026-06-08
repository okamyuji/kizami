import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  formatKizamiTomlBlock,
  hasKizamiTomlBlock,
  removeKizamiTomlBlock,
  countKizamiTomlHooks,
  writeKizamiTomlHooks,
  removeKizamiTomlHooksFromFile,
  BEGIN_MARKER,
  END_MARKER,
} from '../../src/hooks/toml';
import type { TomlHook } from '../../src/hooks/toml';

const sampleHooks: TomlHook[] = [
  { event: 'SessionStart', command: 'kizami inject --stdin --runtime kimi', timeout: 5 },
  { event: 'UserPromptSubmit', command: 'kizami recall --stdin --runtime kimi', timeout: 5 },
];

describe('formatKizamiTomlBlock', () => {
  it('should generate BEGIN/END marker block with [[hooks]] entries', () => {
    const result = formatKizamiTomlBlock(sampleHooks);
    expect(result).toContain(BEGIN_MARKER);
    expect(result).toContain(END_MARKER);
    expect(result).toContain('[[hooks]]');
    expect(result).toContain('event = "SessionStart"');
    expect(result).toContain('event = "UserPromptSubmit"');
    expect(result).toContain('command = "kizami inject --stdin --runtime kimi"');
    expect(result).toContain('timeout = 5');
  });

  it('should omit timeout when not provided', () => {
    const hooks: TomlHook[] = [{ event: 'Stop', command: 'echo test' }];
    const result = formatKizamiTomlBlock(hooks);
    expect(result).not.toContain('timeout');
  });

  it('should use TOML literal string when command contains double quotes', () => {
    const hooks: TomlHook[] = [
      { event: 'SessionEnd', command: 'bash -c \'printf "%s" "$INPUT"\'' },
    ];
    const result = formatKizamiTomlBlock(hooks);
    expect(result).toContain("command = '''");
    expect(result).not.toMatch(/command = "[^']/);
  });

  it('should include matcher when provided', () => {
    const hooks: TomlHook[] = [
      { event: 'PreToolUse', matcher: 'Shell', command: 'echo test', timeout: 3 },
    ];
    const result = formatKizamiTomlBlock(hooks);
    expect(result).toContain('matcher = "Shell"');
  });
});

describe('hasKizamiTomlBlock', () => {
  it('should return true when markers exist', () => {
    const content = `[some_config]\nkey = "val"\n\n${BEGIN_MARKER}\n[[hooks]]\nevent = "Stop"\n${END_MARKER}\n`;
    expect(hasKizamiTomlBlock(content)).toBe(true);
  });

  it('should return false when no markers', () => {
    expect(hasKizamiTomlBlock('[[hooks]]\nevent = "Stop"\n')).toBe(false);
    expect(hasKizamiTomlBlock('')).toBe(false);
  });
});

describe('removeKizamiTomlBlock', () => {
  it('should remove marker block and preserve surrounding content', () => {
    const content = [
      '[[hooks]]',
      'event = "PreToolUse"',
      'command = "user-hook"',
      '',
      BEGIN_MARKER,
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "kizami inject"',
      END_MARKER,
      '',
      '[other]',
      'key = "val"',
    ].join('\n');
    const result = removeKizamiTomlBlock(content);
    expect(result).toContain('event = "PreToolUse"');
    expect(result).toContain('key = "val"');
    expect(result).not.toContain(BEGIN_MARKER);
    expect(result).not.toContain('kizami inject');
  });

  it('should return content unchanged when no markers', () => {
    const content = '[[hooks]]\nevent = "Stop"\ncommand = "echo"\n';
    expect(removeKizamiTomlBlock(content)).toBe(content);
  });

  it('should handle Windows line endings', () => {
    const content = `before\r\n${BEGIN_MARKER}\r\n[[hooks]]\r\nevent = "X"\r\n${END_MARKER}\r\nafter\r\n`;
    const result = removeKizamiTomlBlock(content);
    expect(result).not.toContain(BEGIN_MARKER);
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('should handle block at end of file without trailing newline', () => {
    const content = `[config]\nkey = "val"\n\n${BEGIN_MARKER}\n[[hooks]]\nevent = "X"\n${END_MARKER}`;
    const result = removeKizamiTomlBlock(content);
    expect(result).not.toContain(BEGIN_MARKER);
    expect(result).toContain('key = "val"');
  });

  it('should not leave excessive blank lines after removal', () => {
    const content = `[config]\nkey = "val"\n\n\n${BEGIN_MARKER}\n[[hooks]]\nevent = "X"\n${END_MARKER}\n\n\n[other]\nk = "v"\n`;
    const result = removeKizamiTomlBlock(content);
    expect(result).not.toMatch(/\n{4,}/);
  });
});

describe('countKizamiTomlHooks', () => {
  it('should count [[hooks]] entries within marker block', () => {
    const block = formatKizamiTomlBlock(sampleHooks);
    expect(countKizamiTomlHooks(block)).toBe(2);
  });

  it('should return 0 when no markers', () => {
    expect(countKizamiTomlHooks('[[hooks]]\nevent = "Stop"\n')).toBe(0);
  });

  it('should not count [[hooks]] outside marker block', () => {
    const content = `[[hooks]]\nevent = "user"\n\n${BEGIN_MARKER}\n[[hooks]]\nevent = "kizami"\n${END_MARKER}\n`;
    expect(countKizamiTomlHooks(content)).toBe(1);
  });
});

describe('file operations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-toml-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeKizamiTomlHooks', () => {
    it('should create file with marker block when file does not exist', () => {
      const filePath = path.join(tmpDir, 'config.toml');
      writeKizamiTomlHooks(filePath, sampleHooks);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain(BEGIN_MARKER);
      expect(content).toContain(END_MARKER);
      expect(countKizamiTomlHooks(content)).toBe(2);
    });

    it('should create parent directories if needed', () => {
      const filePath = path.join(tmpDir, 'nested', 'dir', 'config.toml');
      writeKizamiTomlHooks(filePath, sampleHooks);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('should replace existing marker block', () => {
      const filePath = path.join(tmpDir, 'config.toml');
      writeKizamiTomlHooks(filePath, sampleHooks);
      const singleHook: TomlHook[] = [
        { event: 'SessionStart', command: 'kizami inject --stdin --runtime kimi', timeout: 5 },
      ];
      writeKizamiTomlHooks(filePath, singleHook);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(countKizamiTomlHooks(content)).toBe(1);
      const markerCount = content.split(BEGIN_MARKER).length - 1;
      expect(markerCount).toBe(1);
    });

    it('should preserve existing non-kizami content', () => {
      const filePath = path.join(tmpDir, 'config.toml');
      fs.writeFileSync(filePath, '[[hooks]]\nevent = "PreToolUse"\ncommand = "user-hook"\n');
      writeKizamiTomlHooks(filePath, sampleHooks);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('command = "user-hook"');
      expect(content).toContain(BEGIN_MARKER);
    });

    it('should preserve file permissions', () => {
      const filePath = path.join(tmpDir, 'config.toml');
      fs.writeFileSync(filePath, 'key = "val"\n', { mode: 0o600 });
      writeKizamiTomlHooks(filePath, sampleHooks);

      const stat = fs.statSync(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('removeKizamiTomlHooksFromFile', () => {
    it('should remove marker block from file', () => {
      const filePath = path.join(tmpDir, 'config.toml');
      const content = `[config]\nkey = "val"\n\n${BEGIN_MARKER}\n[[hooks]]\nevent = "X"\n${END_MARKER}\n`;
      fs.writeFileSync(filePath, content);

      removeKizamiTomlHooksFromFile(filePath);

      const result = fs.readFileSync(filePath, 'utf-8');
      expect(result).not.toContain(BEGIN_MARKER);
      expect(result).toContain('key = "val"');
    });

    it('should no-op when file has no markers', () => {
      const filePath = path.join(tmpDir, 'config.toml');
      const content = '[[hooks]]\nevent = "Stop"\n';
      fs.writeFileSync(filePath, content);

      removeKizamiTomlHooksFromFile(filePath);

      expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
    });

    it('should no-op when file does not exist', () => {
      const filePath = path.join(tmpDir, 'nonexistent.toml');
      expect(() => removeKizamiTomlHooksFromFile(filePath)).not.toThrow();
    });
  });
});
