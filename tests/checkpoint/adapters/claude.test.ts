import { describe, it, expect } from 'vitest';
import { claudeAdapter } from '@/checkpoint/adapters/claude';

describe('claudeAdapter', () => {
  describe('parsePrompt', () => {
    it('parses valid Claude prompt payload', () => {
      const raw = JSON.stringify({ session_id: 's1', prompt: 'hello', cwd: '/tmp' });
      const result = claudeAdapter.parsePrompt(raw);
      expect(result).toBeDefined();
      expect(result!.session_id).toBe('s1');
      expect(result!.prompt).toBe('hello');
    });

    it('returns null for missing session_id', () => {
      const raw = JSON.stringify({ prompt: 'hello' });
      expect(claudeAdapter.parsePrompt(raw)).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(claudeAdapter.parsePrompt('{broken')).toBeNull();
    });
  });

  describe('parseStop', () => {
    it('parses valid Stop payload', () => {
      const raw = JSON.stringify({
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        last_assistant_message: 'hi',
      });
      const result = claudeAdapter.parseStop(raw);
      expect(result).toBeDefined();
      expect(result!.session_id).toBe('s1');
      expect(result!.transcript_path).toBe('/tmp/t.jsonl');
    });

    it('returns null without transcript_path', () => {
      const raw = JSON.stringify({ session_id: 's1', cwd: '/tmp' });
      expect(claudeAdapter.parseStop(raw)).toBeNull();
    });
  });
});
