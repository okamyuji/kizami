import { describe, it, expect } from 'vitest';
import { classifyJsonLifecycleCommand, isHistoricalLifecycleCommand } from '@/hooks/ownership';

describe('classifyJsonLifecycleCommand', () => {
  it('classifies managed commands with marker', () => {
    expect(
      classifyJsonLifecycleCommand('kizami save --stdin # kizami-managed', 'Stop', 'claude')
    ).toBe('managed');
  });

  it('classifies historical bare kizami inject', () => {
    expect(classifyJsonLifecycleCommand('kizami inject --stdin', 'SessionStart', 'claude')).toBe(
      'historical'
    );
  });

  it('classifies historical kizami recall with runtime', () => {
    expect(
      classifyJsonLifecycleCommand(
        'kizami recall --stdin --runtime claude',
        'UserPromptSubmit',
        'claude'
      )
    ).toBe('historical');
  });

  it('classifies historical kizami save', () => {
    expect(
      classifyJsonLifecycleCommand('kizami save --stdin --runtime codex', 'Stop', 'codex')
    ).toBe('historical');
  });

  it('rejects kizami search (wrong subcommand)', () => {
    expect(classifyJsonLifecycleCommand('kizami search --stdin', 'Stop', 'claude')).toBe(
      'unrelated'
    );
  });

  it('rejects pipe to another consumer', () => {
    expect(
      classifyJsonLifecycleCommand('kizami recall --stdin | grep foo', 'UserPromptSubmit', 'claude')
    ).toBe('unrelated');
  });

  it('rejects different executable', () => {
    expect(classifyJsonLifecycleCommand('my-kizami save --stdin', 'Stop', 'claude')).toBe(
      'unrelated'
    );
  });

  it('rejects kizami without --stdin', () => {
    expect(classifyJsonLifecycleCommand('kizami save', 'Stop', 'claude')).toBe('unrelated');
  });

  it('classifies absolute path kizami', () => {
    expect(
      classifyJsonLifecycleCommand(
        '/usr/local/bin/kizami recall --stdin',
        'UserPromptSubmit',
        'claude'
      )
    ).toBe('historical');
  });
});

describe('isHistoricalLifecycleCommand', () => {
  it('returns true for historical commands', () => {
    expect(isHistoricalLifecycleCommand('kizami save --stdin', 'Stop', 'claude')).toBe(true);
  });

  it('returns false for managed commands', () => {
    expect(
      isHistoricalLifecycleCommand('kizami save --stdin # kizami-managed', 'Stop', 'claude')
    ).toBe(false);
  });

  it('returns false for unrelated commands', () => {
    expect(isHistoricalLifecycleCommand('echo hello', 'Stop', 'claude')).toBe(false);
  });
});
