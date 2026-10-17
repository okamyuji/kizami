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

const line = (value: unknown) => JSON.stringify(value);

// asBefore は 0.8.5 以前の読み方を再現する。blob 行を発言の行として書く
function writeTranscript(file: string, project: string, asBefore = false): void {
  const base = { sessionId: 'blob-session', cwd: project, timestamp: new Date().toISOString() };
  const blob = (role: 'user' | 'assistant', content: unknown) =>
    line({ ...base, type: asBefore ? role : 'api-request-blob', message: { role, content } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      line({ ...base, type: 'user', message: { role: 'user', content: 'retrypolicyquestion' } }),
      blob('user', '<system-reminder>requestcopymarker</system-reminder>'),
      blob('assistant', [{ type: 'text', text: 'requestcopymarker' }]),
      line({
        ...base,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'retrypolicyanswer' }] },
      }),
    ].join('\n') + '\n'
  );
}

function setup(): { root: string; project: string; transcript: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-e2e-blob-'));
  dirs.push(root);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const transcript = path.join(root, 'claude', 'projects', '-project', 'blob-session.jsonl');
  return { root, project, transcript };
}

function save(root: string, project: string, transcript: string, event: string) {
  return runCli(
    root,
    ['save', '--stdin', '--runtime', 'claude'],
    line({
      hook_event_name: event,
      session_id: 'blob-session',
      cwd: project,
      transcript_path: transcript,
    })
  );
}

function expectOnlyConversation(root: string): void {
  const conversation = runCli(root, ['search', 'retrypolicyquestion']);
  expect(conversation.stdout).toContain('retrypolicyanswer');
  expect(conversation.stdout).not.toContain('system-reminder');
  expect(runCli(root, ['search', 'requestcopymarker']).stdout).not.toContain('requestcopymarker');
}

describe('built CLI with a Claude Code transcript that holds api-request-blob lines', () => {
  it('saves only the conversation, so search never returns the request copy', () => {
    const { root, project, transcript } = setup();
    writeTranscript(transcript, project);

    expect(save(root, project, transcript, 'SessionEnd').status).toBe(0);

    expectOnlyConversation(root);
  });

  it('repairs a session that an older version saved with the request copy on the next search', () => {
    const { root, project, transcript } = setup();
    writeTranscript(transcript, project, true);
    expect(save(root, project, transcript, 'Stop').status).toBe(0);
    writeTranscript(transcript, project);

    expectOnlyConversation(root);
  });
});
