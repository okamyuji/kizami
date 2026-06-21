import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { PendingPromptV2 } from '../../src/checkpoint/types';
import {
  writeDurableJson,
  writeDurableJsonWithAdapter,
  writePendingPrompt,
  readPendingPrompts,
  writePreparedCheckpoint,
  updatePreparedPhase,
  writeRuntimeCursor,
  quarantineMalformedState,
  removePendingPrompt,
  finalizePreparedCheckpoint,
  markPreparedSuperseded,
  type PreparedCheckpointV2,
  type RuntimeCursorV2,
  type DurableFsAdapter,
} from '../../src/checkpoint/state';

describe('checkpoint state', () => {
  let tmpDir: string;
  let stateRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-state-'));
    stateRoot = path.join(tmpDir, 'state');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePending(overrides: Partial<PendingPromptV2> = {}): PendingPromptV2 {
    return {
      version: 2,
      runtime: 'kimi',
      sessionId: 'session-1',
      projectPath: '/project',
      prompt: 'hello',
      source: {},
      pendingKey: 'kimi-session-1-key-1',
      turnSequence: 1,
      sourceOrder: '00000000000000000001',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('writeDurableJson', () => {
    it('writes file with mode 0600', () => {
      const filePath = path.join(stateRoot, 'test.json');
      writeDurableJson(filePath, { hello: 'world' });
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    });

    it('uses temp-write, fsync, close, rename, parent-fsync call order via injected adapter', () => {
      const filePath = path.join(stateRoot, 'ordered.json');
      const dir = path.dirname(filePath);
      const calls: Array<{ method: string; args: unknown[] }> = [];
      let nextFd = 100;

      const adapter: DurableFsAdapter = {
        mkdirSync: (p, options) => {
          calls.push({ method: 'mkdirSync', args: [p, options] });
          return undefined;
        },
        openSync: (p, flags, mode) => {
          calls.push({ method: 'openSync', args: [p, flags, mode] });
          return nextFd++;
        },
        writeSync: (fd, buffer, offset, length, position) => {
          calls.push({ method: 'writeSync', args: [fd, buffer, offset, length, position] });
          return length;
        },
        fsyncSync: (fd) => {
          calls.push({ method: 'fsyncSync', args: [fd] });
        },
        closeSync: (fd) => {
          calls.push({ method: 'closeSync', args: [fd] });
        },
        renameSync: (oldPath, newPath) => {
          calls.push({ method: 'renameSync', args: [oldPath, newPath] });
        },
        rmSync: (p, options) => {
          calls.push({ method: 'rmSync', args: [p, options] });
        },
        existsSync: () => false,
        readFileSync: () => {
          throw new Error('not implemented');
        },
        readdirSync: () => [],
      };

      writeDurableJsonWithAdapter(adapter, filePath, { value: 1 });

      const methodNames = calls.map((c) => c.method);
      expect(methodNames).toEqual([
        'mkdirSync',
        'openSync',
        'writeSync',
        'fsyncSync',
        'closeSync',
        'renameSync',
        'openSync',
        'fsyncSync',
        'closeSync',
      ]);

      const mkdirCall = calls.find((c) => c.method === 'mkdirSync');
      expect(mkdirCall?.args[0]).toBe(dir);

      const openCalls = calls.filter((c) => c.method === 'openSync');
      const tempFd = openCalls[0].args[0] as string;
      expect(tempFd.startsWith(`${filePath}.tmp.`)).toBe(true);

      const renameCall = calls.find((c) => c.method === 'renameSync');
      expect(renameCall?.args[0]).toBe(tempFd);
      expect(renameCall?.args[1]).toBe(filePath);

      const fsyncCalls = calls.filter((c) => c.method === 'fsyncSync');
      expect(fsyncCalls).toHaveLength(2);
      const closeCalls = calls.filter((c) => c.method === 'closeSync');
      expect(closeCalls).toHaveLength(2);

      const renameIndex = methodNames.indexOf('renameSync');
      expect(methodNames.indexOf('fsyncSync')).toBeLessThan(renameIndex);
      expect(methodNames.lastIndexOf('fsyncSync')).toBeGreaterThan(renameIndex);
    });
  });

  describe('pending prompts', () => {
    it('writes a pending prompt and returns its file path', () => {
      const pending = makePending();
      const filePath = writePendingPrompt(stateRoot, pending);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(path.dirname(filePath)).toBe(path.join(stateRoot, 'pending', 'kimi'));
      expect(path.extname(filePath)).toBe('.json');
    });

    it('is idempotent for same-key same-content writes', () => {
      const pending = makePending();
      const first = writePendingPrompt(stateRoot, pending);
      const second = writePendingPrompt(stateRoot, makePending({ prompt: 'hello' }));
      expect(first).toBe(second);
      expect(readPendingPrompts(stateRoot, 'kimi', 'session-1')).toHaveLength(1);
    });

    it('quarantines a conflicting same-key write with different content', () => {
      const pending = makePending();
      const first = writePendingPrompt(stateRoot, pending);
      const second = writePendingPrompt(stateRoot, makePending({ prompt: 'different' }));
      // Same pendingKey maps to the same durable path; the old content is quarantined.
      expect(second).toBe(first);
      expect(fs.existsSync(first)).toBe(true);
      const dirFiles = fs.readdirSync(path.join(stateRoot, 'pending', 'kimi'));
      expect(dirFiles.some((n) => n.startsWith('.invalid'))).toBe(true);
      expect(readPendingPrompts(stateRoot, 'kimi', 'session-1')).toHaveLength(1);
      expect(readPendingPrompts(stateRoot, 'kimi', 'session-1')[0].prompt).toBe('different');
    });

    it('quarantines malformed JSON and continues reading', () => {
      const pendingDir = path.join(stateRoot, 'pending', 'kimi');
      fs.mkdirSync(pendingDir, { recursive: true });
      const good = writePendingPrompt(stateRoot, makePending());
      const badPath = path.join(pendingDir, 'corrupt.json');
      fs.writeFileSync(badPath, '{not json', { mode: 0o600 });
      const prompts = readPendingPrompts(stateRoot, 'kimi', 'session-1');
      expect(prompts).toHaveLength(1);
      expect(fs.existsSync(badPath)).toBe(false);
      expect(fs.readdirSync(pendingDir).some((n) => n.startsWith('.invalid'))).toBe(true);
      expect(good).toBe(prompts[0].source.path);
    });

    it('recovers a Kimi pending file older than 24 hours without deleting it', () => {
      const pendingDir = path.join(stateRoot, 'pending', 'kimi');
      fs.mkdirSync(pendingDir, { recursive: true });
      const legacyName = 'session-1-legacy.json';
      const filePath = path.join(pendingDir, legacyName);
      const legacy = {
        sessionId: 'session-1',
        cwd: '/project',
        prompt: 'old prompt',
        createdAt: '2020-01-01T00:00:00.000Z',
      };
      fs.writeFileSync(filePath, JSON.stringify(legacy), { mode: 0o600 });

      const prompts = readPendingPrompts(stateRoot, 'kimi', 'session-1');
      expect(prompts).toHaveLength(1);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(prompts[0].prompt).toBe('old prompt');
      expect(prompts[0].projectPath).toBe('/project');
      expect(prompts[0].createdAt).toBe('2020-01-01T00:00:00.000Z');
    });

    it('ignores hidden and temp files', () => {
      const pendingDir = path.join(stateRoot, 'pending', 'kimi');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(path.join(pendingDir, '.hidden.json'), JSON.stringify(makePending()));
      fs.writeFileSync(
        path.join(pendingDir, 'temp.json.tmp.abc123'),
        JSON.stringify(makePending())
      );
      const filePath = writePendingPrompt(stateRoot, makePending());
      const prompts = readPendingPrompts(stateRoot, 'kimi', 'session-1');
      expect(prompts).toHaveLength(1);
      expect(prompts[0].source.path).toBe(filePath);
    });

    it('filters by session id', () => {
      writePendingPrompt(stateRoot, makePending({ sessionId: 'session-1' }));
      writePendingPrompt(
        stateRoot,
        makePending({ sessionId: 'session-2', pendingKey: 'kimi-session-2-key-1' })
      );
      expect(readPendingPrompts(stateRoot, 'kimi', 'session-1')).toHaveLength(1);
      expect(readPendingPrompts(stateRoot, 'kimi', 'session-2')).toHaveLength(1);
      expect(readPendingPrompts(stateRoot, 'kimi', 'session-missing')).toHaveLength(0);
    });

    it('removes a pending prompt', () => {
      const filePath = writePendingPrompt(stateRoot, makePending());
      removePendingPrompt(filePath);
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe('prepared checkpoints', () => {
    function makePrepared(overrides: Partial<PreparedCheckpointV2> = {}): PreparedCheckpointV2 {
      return {
        version: 2,
        phase: 'prepared',
        txId: 'tx-1',
        runtime: 'kimi',
        sessionId: 'session-1',
        targetPath: '/tmp/out.jsonl',
        payloadDigest: 'digest',
        allLines: [],
        records: [],
        turnKeys: ['turn-1'],
        finalization: { pendingPaths: [] },
        ...overrides,
      };
    }

    it('writes a prepared checkpoint and returns its file path', () => {
      const prepared = makePrepared();
      const filePath = writePreparedCheckpoint(stateRoot, prepared);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(path.dirname(filePath)).toBe(path.join(stateRoot, 'prepared', 'kimi'));
    });

    it('updates phase atomically via rename', () => {
      const filePath = writePreparedCheckpoint(stateRoot, makePrepared());
      const statBefore = fs.statSync(filePath);
      updatePreparedPhase(filePath, 'jsonl_committed');
      const statAfter = fs.statSync(filePath);
      expect(statAfter.ino).not.toBe(statBefore.ino);
      const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PreparedCheckpointV2;
      expect(updated.phase).toBe('jsonl_committed');
    });

    it('finalizes a prepared checkpoint', () => {
      const filePath = writePreparedCheckpoint(stateRoot, makePrepared());
      finalizePreparedCheckpoint(filePath);
      const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PreparedCheckpointV2;
      expect(updated.phase).toBe('finalized');
    });

    it('marks a prepared checkpoint superseded with a reason', () => {
      const filePath = writePreparedCheckpoint(stateRoot, makePrepared());
      markPreparedSuperseded(filePath, 'stale boundary');
      const updated = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PreparedCheckpointV2;
      expect(updated.phase).toBe('superseded');
    });
  });

  describe('runtime cursor', () => {
    it('writes a runtime cursor', () => {
      const cursor: RuntimeCursorV2 = {
        version: 2,
        runtime: 'kimi',
        sessionId: 'session-1',
        fileIdentity: 'wire.jsonl',
        completeOffset: 100,
      };
      writeRuntimeCursor(stateRoot, 'kimi', 'session-1', cursor);
      const cursorPath = path.join(stateRoot, 'cursors', 'kimi');
      const files = fs.readdirSync(cursorPath).filter((n) => n.endsWith('.json'));
      expect(files).toHaveLength(1);
      const read = JSON.parse(
        fs.readFileSync(path.join(cursorPath, files[0]), 'utf-8')
      ) as RuntimeCursorV2;
      expect(read.runtime).toBe('kimi');
      expect(read.sessionId).toBe('session-1');
      expect(read.completeOffset).toBe(100);
    });
  });

  describe('quarantineMalformedState', () => {
    it('renames a file to a hidden .invalid name and retains it', () => {
      fs.mkdirSync(stateRoot, { recursive: true });
      const filePath = path.join(stateRoot, 'bad.json');
      fs.writeFileSync(filePath, '{}', { mode: 0o600 });
      const quarantined = quarantineMalformedState(filePath, 'bad json');
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(quarantined)).toBe(true);
      expect(path.basename(quarantined).startsWith('.invalid')).toBe(true);
    });
  });
});
