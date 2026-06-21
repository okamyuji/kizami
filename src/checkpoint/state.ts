import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { HookRuntime, PendingPromptV2 } from '@/checkpoint/types';
import type { JsonlV2Record } from '@/jsonl/types';

export interface RuntimeCursorV2 {
  version: 2;
  runtime: HookRuntime;
  sessionId: string;
  fileIdentity?: string;
  sourceGeneration?: number;
  completeOffset?: number;
  fingerprint?: string;
  runtimeState?: Record<string, unknown>;
}

export interface PreparedCheckpointV2 {
  version: 2;
  phase: 'prepared' | 'jsonl_committed' | 'sqlite_applied' | 'finalized' | 'superseded';
  txId: string;
  runtime: HookRuntime;
  sessionId: string;
  targetPath: string;
  payloadDigest: string;
  allLines: string[];
  records: JsonlV2Record[];
  turnKeys: string[];
  finalization: {
    pendingPaths: string[];
    cursorPath?: string;
    cursorAfter?: RuntimeCursorV2;
  };
  supersededReason?: string;
}

interface LegacyKimiPending {
  sessionId: string;
  cwd: string;
  prompt: string;
  createdAt: string;
}

const STATE_DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TEMP_SUFFIX_RE = /\.tmp\.[a-f0-9]+$/i;

export interface DurableFsAdapter {
  mkdirSync(path: string, options: { recursive: boolean; mode?: number }): string | undefined;
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null
  ): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, options: { force: boolean }): void;
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf-8'): string;
  readdirSync(path: string, options: { withFileTypes: true }): fs.Dirent[];
}

const defaultAdapter: DurableFsAdapter = {
  mkdirSync: fs.mkdirSync,
  openSync: fs.openSync,
  writeSync: fs.writeSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  rmSync: fs.rmSync,
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync,
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function pendingFileName(runtime: HookRuntime, sessionId: string, pendingKey: string): string {
  return sha256Hex(`${runtime}\0${sessionId}\0${pendingKey}`);
}

function preparedFileName(txId: string): string {
  return sha256Hex(txId);
}

function cursorFileName(runtime: HookRuntime, sessionId: string): string {
  return sha256Hex(`${runtime}\0${sessionId}`);
}

function stateDir(
  stateRoot: string,
  kind: 'pending' | 'prepared' | 'cursors',
  runtime: HookRuntime
): string {
  return path.join(stateRoot, kind, runtime);
}

function writeAll(adapter: DurableFsAdapter, fd: number, data: string): void {
  const buffer = Buffer.from(data, 'utf-8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = adapter.writeSync(fd, buffer, offset, buffer.length - offset, undefined);
    if (written <= 0) {
      throw new Error(`writeSync returned ${written}`);
    }
    offset += written;
  }
}

function fsyncAndClose(adapter: DurableFsAdapter, fd: number): void {
  try {
    adapter.fsyncSync(fd);
  } finally {
    adapter.closeSync(fd);
  }
}

function fsyncParentDir(adapter: DurableFsAdapter, filePath: string): void {
  const dir = path.dirname(filePath);
  const dirFd = adapter.openSync(dir, 'r');
  try {
    adapter.fsyncSync(dirFd);
  } finally {
    adapter.closeSync(dirFd);
  }
}

export function writeDurableJsonWithAdapter<T>(
  adapter: DurableFsAdapter,
  filePath: string,
  value: T,
  mode = FILE_MODE
): void {
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp.${randomBytes(8).toString('hex')}`;
  let fd: number | undefined;

  try {
    adapter.mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
    const json = JSON.stringify(value);
    fd = adapter.openSync(tmpPath, 'w', mode);
    writeAll(adapter, fd, json);
    fsyncAndClose(adapter, fd);
    fd = undefined;
    adapter.renameSync(tmpPath, filePath);
    fsyncParentDir(adapter, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        adapter.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      adapter.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function writeDurableJson<T>(filePath: string, value: T, mode = FILE_MODE): void {
  return writeDurableJsonWithAdapter(defaultAdapter, filePath, value, mode);
}

function isPendingPromptV2(value: unknown): value is PendingPromptV2 {
  const p = value as Partial<PendingPromptV2> | undefined;
  if (!p || typeof p !== 'object') return false;
  return (
    p.version === 2 &&
    typeof p.runtime === 'string' &&
    typeof p.sessionId === 'string' &&
    typeof p.projectPath === 'string' &&
    typeof p.prompt === 'string' &&
    typeof p.pendingKey === 'string' &&
    typeof p.turnSequence === 'number' &&
    typeof p.sourceOrder === 'string' &&
    typeof p.createdAt === 'string'
  );
}

function normalizeLegacyKimiPending(data: unknown): PendingPromptV2 | null {
  const p = data as Partial<LegacyKimiPending> | undefined;
  if (!p || typeof p !== 'object') return null;
  if (
    typeof p.sessionId !== 'string' ||
    typeof p.cwd !== 'string' ||
    typeof p.prompt !== 'string' ||
    typeof p.createdAt !== 'string'
  ) {
    return null;
  }
  const pendingKey = `kimi\0${p.sessionId}\0legacy\0${p.createdAt}\0${p.prompt}`;
  return {
    version: 2,
    runtime: 'kimi',
    sessionId: p.sessionId,
    projectPath: p.cwd,
    prompt: p.prompt,
    source: {},
    pendingKey,
    turnSequence: 0,
    sourceOrder: '00000000000000000000',
    createdAt: p.createdAt,
  };
}

function normalizePending(runtime: HookRuntime, data: unknown): PendingPromptV2 | null {
  if (isPendingPromptV2(data)) return data;
  if (runtime === 'kimi') return normalizeLegacyKimiPending(data);
  return null;
}

export function writePendingPrompt(stateRoot: string, pending: PendingPromptV2): string {
  const dir = stateDir(stateRoot, 'pending', pending.runtime);
  const fileName = `${pendingFileName(pending.runtime, pending.sessionId, pending.pendingKey)}.json`;
  const filePath = path.join(dir, fileName);
  const pendingWithPath: PendingPromptV2 = {
    ...pending,
    source: { ...pending.source, path: filePath },
  };

  if (fs.existsSync(filePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (isPendingPromptV2(existing) && existing.pendingKey === pendingWithPath.pendingKey) {
        if (JSON.stringify(existing) === JSON.stringify(pendingWithPath)) {
          return filePath;
        }
        quarantineMalformedState(filePath, 'conflicting pending content for same pendingKey');
      }
    } catch {
      quarantineMalformedState(filePath, 'unreadable existing pending file');
    }
  }

  writeDurableJson(filePath, pendingWithPath);
  return filePath;
}

export function readPendingPrompts(
  stateRoot: string,
  runtime: HookRuntime,
  sessionId: string
): PendingPromptV2[] {
  const dir = stateDir(stateRoot, 'pending', runtime);
  if (!fs.existsSync(dir)) return [];

  const results: PendingPromptV2[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.')) continue;
    if (TEMP_SUFFIX_RE.test(entry.name)) continue;
    if (!entry.name.endsWith('.json')) continue;

    const filePath = path.join(dir, entry.name);
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    } catch {
      quarantineMalformedState(filePath, 'malformed JSON');
      continue;
    }

    const pending = normalizePending(runtime, data);
    if (!pending) {
      quarantineMalformedState(filePath, 'unrecognized pending format');
      continue;
    }

    if (pending.sessionId !== sessionId) continue;

    results.push({
      ...pending,
      source: { ...pending.source, path: filePath },
    });
  }

  return results.sort((a, b) => a.sourceOrder.localeCompare(b.sourceOrder));
}

export function removePendingPrompt(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

export function writePreparedCheckpoint(stateRoot: string, value: PreparedCheckpointV2): string {
  const dir = stateDir(stateRoot, 'prepared', value.runtime);
  const fileName = `${preparedFileName(value.txId)}.json`;
  const filePath = path.join(dir, fileName);
  writeDurableJson(filePath, value);
  return filePath;
}

export function updatePreparedPhase(filePath: string, phase: PreparedCheckpointV2['phase']): void {
  const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PreparedCheckpointV2;
  const updated: PreparedCheckpointV2 = { ...existing, phase };
  writeDurableJson(filePath, updated);
}

export function finalizePreparedCheckpoint(filePath: string): void {
  updatePreparedPhase(filePath, 'finalized');
}

export function markPreparedSuperseded(filePath: string, reason: string): void {
  const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PreparedCheckpointV2;
  const updated: PreparedCheckpointV2 = {
    ...existing,
    phase: 'superseded',
    supersededReason: reason,
  };
  writeDurableJson(filePath, updated);
}

export function writeRuntimeCursor(
  stateRoot: string,
  runtime: HookRuntime,
  sessionId: string,
  cursor: RuntimeCursorV2
): void {
  const dir = stateDir(stateRoot, 'cursors', runtime);
  const fileName = `${cursorFileName(runtime, sessionId)}.json`;
  const filePath = path.join(dir, fileName);
  writeDurableJson(filePath, cursor);
}

export function quarantineMalformedState(filePath: string, reason: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const quarantined = path.join(dir, `.invalid.${base}.${Date.now()}`);
  fs.renameSync(filePath, quarantined);
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* ignore */
  }
  process.stderr.write(`Quarantined malformed state: ${filePath} -> ${quarantined} (${reason})\n`);
  return quarantined;
}
