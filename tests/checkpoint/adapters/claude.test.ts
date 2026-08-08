import { afterEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeAdapter } from '@/checkpoint/adapters/claude';
import { getDefaultConfig } from '@/config';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

  it('uses the transcript position as fallback source order and compares only the last assistant message', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-claude-adapter-'));
    tempDirs.push(root);
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const records = [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Earlier turn' }] },
        sessionId: 's1',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
        sessionId: 's1',
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Run tests' }] },
        sessionId: 's1',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running.' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pnpm test' } },
          ],
        },
        sessionId: 's1',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'passed',
              is_error: false,
            },
          ],
        },
        sessionId: 's1',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer' }] },
        sessionId: 's1',
      },
    ];
    fs.writeFileSync(
      transcriptPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    );

    const result = await claudeAdapter.extractStop(
      {
        session_id: 's1',
        transcript_path: transcriptPath,
        cwd: root,
        last_assistant_message: 'Final answer',
      },
      {
        config: getDefaultConfig(),
        stateRoot: root,
        now: () => new Date('2026-08-08T00:00:00Z'),
        getOrCreateTurnSequence: () => 1,
        allocateTurnSequenceRange: () => [1],
        reserveObservationSequence: () => 1,
        log: () => undefined,
      }
    );

    expect(result.status).toBe('ready');
    expect(result.candidates[0].sourceOrder).toBe('00000000000000000003');
    expect(result.candidates[0].executions).toEqual([
      {
        executionIndex: 0,
        toolName: 'Bash',
        command: 'pnpm test',
        status: 'succeeded',
        outputExcerpt: 'passed',
      },
    ]);
  });
});
