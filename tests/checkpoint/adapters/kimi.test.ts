import { describe, it, expect } from 'vitest';
import { kimiAdapter } from '@/checkpoint/adapters/kimi';

describe('kimiAdapter', () => {
  describe('parsePrompt', () => {
    it('parses valid Kimi prompt', () => {
      const raw = JSON.stringify({ session_id: 's1', prompt: 'hello', cwd: '/tmp' });
      const result = kimiAdapter.parsePrompt(raw);
      expect(result).toBeDefined();
      expect(result!.session_id).toBe('s1');
      expect(result!.prompt).toBe('hello');
    });

    it('parses array prompt', () => {
      const raw = JSON.stringify({
        session_id: 's1',
        prompt: [{ type: 'text', text: 'hello' }],
      });
      const result = kimiAdapter.parsePrompt(raw);
      expect(result).toBeDefined();
      expect(result!.prompt).toBe('hello');
    });

    it('returns null for missing session_id', () => {
      expect(kimiAdapter.parsePrompt('{}')).toBeNull();
    });
  });

  describe('parseStop', () => {
    it('parses valid Stop payload', () => {
      const raw = JSON.stringify({ session_id: 's1', cwd: '/tmp' });
      const result = kimiAdapter.parseStop(raw);
      expect(result).toBeDefined();
      expect(result!.session_id).toBe('s1');
    });
  });

  describe('parseSessionEnd', () => {
    it('parses valid SessionEnd payload', () => {
      const raw = JSON.stringify({ session_id: 's1', reason: 'user_exit' });
      const result = kimiAdapter.parseSessionEnd(raw);
      expect(result).toBeDefined();
      expect(result!.reason).toBe('user_exit');
    });
  });

  describe('extractStop', () => {
    it('defers for Kimi Stop (wire schema verification required)', async () => {
      const env = {
        config: {} as never,
        stateRoot: '/tmp',
        now: () => new Date(),
        getOrCreateTurnSequence: () => 1,
        allocateTurnSequenceRange: () => [1],
        reserveObservationSequence: () => 1,
        log: () => {},
      };
      const payload = { session_id: 's1' };
      const result = await kimiAdapter.extractStop(payload, env);
      expect(result.status).toBe('deferred');
    });
  });
});
