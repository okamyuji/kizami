import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensureOfflineByDefault } from '@/search/embedding';

const KEYS = ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'] as const;

describe('ensureOfflineByDefault', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('sets HF_HUB_OFFLINE=1 and TRANSFORMERS_OFFLINE=1 when unset', () => {
    ensureOfflineByDefault();
    expect(process.env['HF_HUB_OFFLINE']).toBe('1');
    expect(process.env['TRANSFORMERS_OFFLINE']).toBe('1');
  });

  it('respects user-provided HF_HUB_OFFLINE=0', () => {
    process.env['HF_HUB_OFFLINE'] = '0';
    ensureOfflineByDefault();
    expect(process.env['HF_HUB_OFFLINE']).toBe('0');
  });

  it('respects user-provided TRANSFORMERS_OFFLINE=0', () => {
    process.env['TRANSFORMERS_OFFLINE'] = '0';
    ensureOfflineByDefault();
    expect(process.env['TRANSFORMERS_OFFLINE']).toBe('0');
  });
});
