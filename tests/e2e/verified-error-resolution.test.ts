import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { serializeV2Transaction } from '@/jsonl/transaction';
import type { JsonlV2Payload } from '@/jsonl/types';
import type { TurnCheckpointV2 } from '@/checkpoint/types';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function checkpoint(
  turnKey: string,
  sourceOrder: string,
  status: 'failed' | 'succeeded',
  outputExcerpt: string,
  command = 'pnpm test'
): TurnCheckpointV2 {
  return {
    sessionId: 'e2e-session',
    runtime: 'claude',
    turnKey,
    sourceOrder,
    observedThrough: { kind: 'source_offset', generation: 0, offset: Number(sourceOrder) },
    historyEpoch: 0,
    revision: 1,
    contentHash: `hash-${turnKey}-${status}`,
    completedAt: `2026-08-08T00:00:0${sourceOrder}Z`,
    projectPath: '/tmp/proj',
    parts: [
      {
        partIndex: 0,
        externalId: `ext-${turnKey}`,
        content: `${status} turn`,
        role: 'assistant',
        metadata: { filePaths: [], toolNames: ['Bash'], errorMessages: [] },
        tokenCount: 2,
      },
    ],
    executions: [
      {
        executionIndex: 0,
        toolName: 'Bash',
        command,
        status,
        outputExcerpt,
      },
    ],
  };
}

function appendTransaction(file: string, checkpointValue: TurnCheckpointV2, txId: string): void {
  const payload: JsonlV2Payload = {
    v: 2,
    type: 'turn_checkpoint',
    txId,
    ...checkpointValue,
  };
  appendPayloads(file, [payload], txId);
}

function appendPayloads(file: string, payloads: JsonlV2Payload[], txId: string): void {
  const serialized = serializeV2Transaction(payloads, {
    txId,
    targetPath: file,
    createdAt: '2026-08-08T00:00:00Z',
  });
  fs.appendFileSync(file, `${serialized.allLines.join('\n')}\n`);
}

function runCli(
  args: string[],
  options: { input?: string; home: string }
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], {
    encoding: 'utf-8',
    input: options.input,
    env: { ...process.env, HOME: options.home },
  });
}

function appendTranscriptRecord(file: string, record: Record<string, unknown>): void {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

describe('built CLI verified error resolution', () => {
  it('captures explicit Claude failure and success through recall and save hooks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-e2e-hooks-'));
    dirs.push(root);
    const jsonlDir = path.join(root, 'jsonl');
    fs.mkdirSync(jsonlDir, { mode: 0o700 });
    const dbPath = path.join(root, 'memory.db');
    const configPath = path.join(root, 'config.json');
    const transcriptPath = path.join(root, 'claude-transcript.jsonl');
    const projectPath = fs.realpathSync(root);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        database: { path: dbPath },
        storage: { jsonlDir },
        maintenance: { enabled: false },
      })
    );

    const sessionId = 'claude-e2e-session';
    const command = 'pnpm test';
    const runTurn = (turn: number, isError: boolean, output: string): void => {
      const prompt = `Run tests ${turn}`;
      appendTranscriptRecord(transcriptPath, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        sessionId,
      });
      const recall = runCli(['recall', '--stdin', '--runtime', 'claude', '--config', configPath], {
        home: root,
        input: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: root,
          prompt,
        }),
      });
      expect(recall.status, recall.stderr).toBe(0);

      const toolId = `tool-${turn}`;
      appendTranscriptRecord(transcriptPath, {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `Running tests ${turn}.` },
            { type: 'tool_use', id: toolId, name: 'Bash', input: { command } },
          ],
        },
        sessionId,
      });
      appendTranscriptRecord(transcriptPath, {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: toolId, content: output, is_error: isError },
          ],
        },
        sessionId,
      });
      const finalText = `Tests ${isError ? 'failed' : 'passed'} on turn ${turn}.`;
      appendTranscriptRecord(transcriptPath, {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: finalText }] },
        sessionId,
      });
      const save = runCli(['save', '--stdin', '--runtime', 'claude', '--config', configPath], {
        home: root,
        input: JSON.stringify({
          hook_event_name: 'Stop',
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: root,
          last_assistant_message: finalText,
        }),
      });
      expect(save.status, save.stderr).toBe(0);
    };

    runTurn(1, true, 'tests failed');
    let stats = runCli(['stats', '--config', configPath], { home: root });
    expect(stats.status, stats.stderr).toBe(0);
    expect(stats.stdout).toContain('Executions (explicit): 1');
    let resolutions = runCli(['resolutions', '--config', configPath, '--project', projectPath], {
      home: root,
    });
    expect(resolutions.status, resolutions.stderr).toBe(0);
    expect(resolutions.stdout).toContain('No verified error resolutions found.');

    runTurn(2, false, 'tests passed');
    stats = runCli(['stats', '--config', configPath], { home: root });
    expect(stats.status, stats.stderr).toBe(0);
    expect(stats.stdout).toContain('Executions (explicit): 2');
    expect(stats.stdout).toContain('Verified resolutions:  1');
    resolutions = runCli(['resolutions', '--config', configPath, '--project', projectPath], {
      home: root,
    });
    expect(resolutions.status, resolutions.stderr).toBe(0);
    expect(resolutions.stdout).toContain(
      'Evidence: hidden (use --show-evidence to display best-effort-masked excerpts)'
    );
    expect(resolutions.stdout).not.toContain('tests failed');
    resolutions = runCli(
      ['resolutions', '--show-evidence', '--config', configPath, '--project', projectPath],
      { home: root }
    );
    expect(resolutions.stdout).toContain('Command: pnpm test');
    expect(resolutions.stdout).toContain('Failed: tests failed');
    expect(resolutions.stdout).toContain('Verified: tests passed');
  });

  it('rebuilds and searches a failure followed by the same successful command', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-e2e-resolution-'));
    dirs.push(root);
    const jsonlDir = path.join(root, 'jsonl');
    fs.mkdirSync(jsonlDir, { mode: 0o700 });
    const dbPath = path.join(root, 'memory.db');
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ database: { path: dbPath }, storage: { jsonlDir } })
    );
    const jsonlFile = path.join(jsonlDir, '2026-08-test.jsonl');
    appendTransaction(jsonlFile, checkpoint('failure', '1', 'failed', 'tests failed'), 'tx-fail');
    appendTransaction(
      jsonlFile,
      checkpoint('success', '2', 'succeeded', 'tests passed'),
      'tx-pass'
    );

    const rebuild = spawnSync(
      process.execPath,
      ['dist/cli.js', 'rebuild', '--config', configPath],
      {
        encoding: 'utf-8',
      }
    );
    expect(rebuild.status, rebuild.stderr).toBe(0);
    const resolutions = spawnSync(
      process.execPath,
      [
        'dist/cli.js',
        'resolutions',
        '--show-evidence',
        '--config',
        configPath,
        '--project',
        '/tmp/proj',
      ],
      { encoding: 'utf-8' }
    );
    expect(resolutions.status, resolutions.stderr).toBe(0);
    expect(resolutions.stdout).toContain('Command: pnpm test');
    expect(resolutions.stdout).toContain('Failed: tests failed');
    expect(resolutions.stdout).toContain('Verified: tests passed');

    appendTransaction(
      jsonlFile,
      {
        ...checkpoint('failure', '1', 'failed', 'unused'),
        revision: 2,
        contentHash: 'revised',
        executions: [],
      },
      'tx-revise'
    );
    const rebuiltAfterRevision = spawnSync(
      process.execPath,
      ['dist/cli.js', 'rebuild', '--config', configPath],
      { encoding: 'utf-8' }
    );
    expect(rebuiltAfterRevision.status, rebuiltAfterRevision.stderr).toBe(0);
    const afterRevision = spawnSync(
      process.execPath,
      ['dist/cli.js', 'resolutions', '--config', configPath, '--project', '/tmp/proj'],
      { encoding: 'utf-8' }
    );
    expect(afterRevision.stdout).toContain('No verified error resolutions found.');
  });

  it('does not resolve a different command and removes an existing resolution after reset', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-e2e-boundaries-'));
    dirs.push(root);
    const jsonlDir = path.join(root, 'jsonl');
    fs.mkdirSync(jsonlDir, { mode: 0o700 });
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ database: { path: path.join(root, 'memory.db') }, storage: { jsonlDir } })
    );
    const jsonlFile = path.join(jsonlDir, '2026-08-test.jsonl');
    appendTransaction(jsonlFile, checkpoint('failure', '1', 'failed', 'failed'), 'tx-failure');
    appendTransaction(
      jsonlFile,
      checkpoint('different-success', '2', 'succeeded', 'different passed', 'pnpm test --changed'),
      'tx-different'
    );

    let rebuild = runCli(['rebuild', '--config', configPath], { home: root });
    expect(rebuild.status, rebuild.stderr).toBe(0);
    let resolutions = runCli(['resolutions', '--config', configPath, '--project', '/tmp/proj'], {
      home: root,
    });
    expect(resolutions.stdout).toContain('No verified error resolutions found.');

    appendTransaction(
      jsonlFile,
      checkpoint('matching-success', '3', 'succeeded', 'matching passed'),
      'tx-matching'
    );
    rebuild = runCli(['rebuild', '--config', configPath], { home: root });
    expect(rebuild.status, rebuild.stderr).toBe(0);
    resolutions = runCli(
      ['resolutions', '--show-evidence', '--config', configPath, '--project', '/tmp/proj'],
      { home: root }
    );
    expect(resolutions.stdout).toContain('Command: pnpm test');

    const resetCheckpoint = {
      ...checkpoint('current', '4', 'succeeded', 'unused'),
      historyEpoch: 1,
      executions: [],
    };
    appendPayloads(
      jsonlFile,
      [
        {
          v: 2,
          type: 'session_reset',
          txId: 'tx-reset',
          sessionId: 'e2e-session',
          historyEpoch: 1,
          reason: 'legacy_mismatch',
        },
        { v: 2, type: 'turn_checkpoint', txId: 'tx-reset', ...resetCheckpoint },
      ],
      'tx-reset'
    );

    rebuild = runCli(['rebuild', '--config', configPath], { home: root });
    expect(rebuild.status, rebuild.stderr).toBe(0);
    resolutions = runCli(['resolutions', '--config', configPath, '--project', '/tmp/proj'], {
      home: root,
    });
    expect(resolutions.stdout).toContain('No verified error resolutions found.');
  });
});
