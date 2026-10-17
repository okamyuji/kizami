import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runCli(root: string, args: string[], input?: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [path.resolve('dist/cli.js'), ...args], {
    encoding: 'utf-8',
    input,
    cwd: path.join(root, 'project'),
    env: {
      ...process.env,
      HOME: root,
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      KIZAMI_JSONL_DIR: path.join(root, 'jsonl'),
      KIZAMI_TRANSCRIPT_ARCHIVE_DIR: path.join(root, 'transcripts'),
    },
  });
}

describe('built CLI with a Claude Code transcript that holds api-request-blob lines', () => {
  it('saves only the conversation, so search never returns the request copy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-e2e-blob-'));
    dirs.push(root);
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const transcript = path.join(root, 'session.jsonl');
    const line = (value: unknown) => JSON.stringify(value);
    const base = { sessionId: 'blob-session', cwd: project, timestamp: '2026-10-01T00:00:00Z' };
    fs.writeFileSync(
      transcript,
      [
        line({ ...base, type: 'user', message: { role: 'user', content: 'retrypolicyquestion' } }),
        line({
          type: 'api-request-blob',
          sessionId: 'blob-session',
          message: {
            role: 'user',
            content: '<system-reminder>requestcopymarker</system-reminder>',
          },
        }),
        line({
          type: 'api-request-blob',
          sessionId: 'blob-session',
          message: { role: 'assistant', content: [{ type: 'text', text: 'requestcopymarker' }] },
        }),
        line({
          ...base,
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'retrypolicyanswer' }] },
        }),
      ].join('\n') + '\n'
    );

    const save = runCli(
      root,
      ['save', '--stdin', '--runtime', 'claude'],
      line({
        hook_event_name: 'SessionEnd',
        session_id: 'blob-session',
        cwd: project,
        transcript_path: transcript,
      })
    );
    expect(save.status).toBe(0);

    const conversation = runCli(root, ['search', 'retrypolicyquestion']);
    expect(conversation.stdout).toContain('retrypolicyanswer');
    const copy = runCli(root, ['search', 'requestcopymarker']);
    expect(copy.stdout).not.toContain('requestcopymarker');
    expect(conversation.stdout).not.toContain('system-reminder');
  });
});
