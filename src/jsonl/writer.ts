import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { ensureJsonlDir, getJsonlFilePath } from '@/jsonl/path';
import type { JsonlChunkRecord } from '@/jsonl/types';
import type {
  CommittedTransaction,
  JsonlV2Payload,
  SerializedJsonlTransaction,
} from '@/jsonl/types';
import type { HookRuntime, ObservationBoundaryV2, TurnCheckpointV2 } from '@/checkpoint/types';
import { compareObservationBoundary } from '@/checkpoint/identity';
import { assertPrivateFileTarget, enforcePrivateFile } from '@/storage/permissions';
import { isJsonlV2Payload, isJsonlV2Record, MAX_JSONL_RECORD_BYTES } from '@/jsonl/transaction';

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
}

function openPrivateFileForAppend(filePath: string): number {
  assertPrivateFileTarget(filePath);
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollowFlag(),
    0o600
  );
  try {
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error: unknown) {
    fs.closeSync(fd);
    throw error;
  }
}

const FILE_SCAN_BLOCK_BYTES = 64 * 1024;

interface FileSnapshot {
  identity: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function snapshotFromStat(stat: fs.Stats): FileSnapshot {
  return {
    identity: `${stat.dev}:${stat.ino}`,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.identity === right.identity &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function getFileSnapshot(filePath: string): FileSnapshot {
  assertPrivateFileTarget(filePath);
  return snapshotFromStat(fs.lstatSync(filePath));
}

function forEachPrivateFileLine(
  filePath: string,
  callback: (line: string | undefined) => void
): FileSnapshot {
  assertPrivateFileTarget(filePath);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  const readBuffer = Buffer.allocUnsafe(FILE_SCAN_BLOCK_BYTES);
  // MAX_JSONL_RECORD_BYTES (4 MiB) の常時確保はbuffer poolを外れGC負荷になるため、
  // 小さく確保して上限まで倍々に成長させる
  let lineBuffer = Buffer.allocUnsafe(FILE_SCAN_BLOCK_BYTES);
  let lineLength = 0;
  let oversized = false;
  let position = 0;

  const visitCurrentLine = (): void => {
    if (oversized) callback(undefined);
    else if (lineLength > 0) callback(lineBuffer.subarray(0, lineLength).toString('utf-8'));
  };

  try {
    const initial = snapshotFromStat(fs.fstatSync(fd));
    while (true) {
      const bytesRead = fs.readSync(fd, readBuffer, 0, readBuffer.length, position);
      if (bytesRead === 0) {
        visitCurrentLine();
        const final = snapshotFromStat(fs.fstatSync(fd));
        if (!sameSnapshot(initial, final)) {
          throw new Error('JSONL file changed while scanning transactions');
        }
        return final;
      }
      position += bytesRead;
      for (let index = 0; index < bytesRead; index++) {
        const byte = readBuffer[index];
        if (byte === 0x0a) {
          visitCurrentLine();
          lineLength = 0;
          oversized = false;
        } else if (lineLength < MAX_JSONL_RECORD_BYTES) {
          if (lineLength === lineBuffer.length) {
            // Stryker disable all: capはメモリ量のみに影響し正しさはlineLength比較が保証する
            const grown = Buffer.allocUnsafe(
              Math.min(lineBuffer.length * 2, MAX_JSONL_RECORD_BYTES)
            );
            // Stryker restore all
            lineBuffer.copy(grown, 0, 0, lineLength);
            lineBuffer = grown;
          }
          lineBuffer[lineLength++] = byte;
        } else {
          oversized = true;
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 単一の月ファイルに対する追記writer。
 * append-only/fsyncあり/プロセスローカルロック（ファイルロックは取らない）。
 */
export class JsonlWriter {
  constructor(private readonly jsonlDir: string) {
    ensureJsonlDir(jsonlDir);
  }

  appendRecords(records: JsonlChunkRecord[], now: Date = new Date()): string {
    if (records.length === 0) {
      return getJsonlFilePath(this.jsonlDir, now);
    }
    const filePath = getJsonlFilePath(this.jsonlDir, now);
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';

    const fd = openPrivateFileForAppend(filePath);
    try {
      writeAllSync(fd, lines);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    enforcePrivateFile(filePath);
    return filePath;
  }
}

// --- v2 Transaction Writer ---

const WRITER_LOCK_DB = '.writer-lock.sqlite';

const COORDINATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS turn_heads (
  session_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  history_epoch INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  observed_through TEXT NOT NULL,
  source_order TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_key)
);

CREATE TABLE IF NOT EXISTS session_epochs (
  session_id TEXT NOT NULL PRIMARY KEY,
  epoch INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS turn_sequences (
  runtime TEXT NOT NULL,
  session_id TEXT NOT NULL,
  pending_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  PRIMARY KEY (runtime, session_id, pending_key)
);

CREATE TABLE IF NOT EXISTS observation_sequences (
  runtime TEXT NOT NULL,
  session_id TEXT NOT NULL,
  next_sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (runtime, session_id)
);

CREATE TABLE IF NOT EXISTS file_replay_offsets (
  file_path TEXT NOT NULL PRIMARY KEY,
  file_identity TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  replay_offset INTEGER NOT NULL,
  hash_chain TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS committed_transactions (
  file_path TEXT NOT NULL,
  tx_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  PRIMARY KEY (file_path, tx_id)
);

CREATE TABLE IF NOT EXISTS file_commit_scan_state (
  file_path TEXT NOT NULL PRIMARY KEY,
  file_identity TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  ctime_ms REAL NOT NULL
);
`;

export interface CanonicalTurnHead {
  sessionId: string;
  turnKey: string;
  historyEpoch: number;
  revision: number;
  contentHash: string;
  observedThrough: ObservationBoundaryV2;
  sourceOrder: string;
}

function shouldAdvanceTurnHead(
  current: CanonicalTurnHead | undefined,
  incoming: TurnCheckpointV2
): boolean {
  if (!current) return true;
  if (incoming.historyEpoch < current.historyEpoch) return false;
  if (incoming.historyEpoch > current.historyEpoch) return true;
  if (incoming.revision < current.revision) return false;
  if (incoming.revision === current.revision) {
    if (incoming.contentHash === current.contentHash) return false;
    throw new Error(
      `Turn ${incoming.turnKey} revision ${incoming.revision} has conflicting content`
    );
  }

  const boundary = compareObservationBoundary(incoming.observedThrough, current.observedThrough);
  if (boundary === 'newer' || boundary === 'equal') return true;
  throw new Error(`Turn ${incoming.turnKey} has a non-monotonic observation boundary`);
}

export interface JsonlTransactionReceipt {
  status: 'inserted' | 'already_committed';
  targetPath: string;
  txId: string;
  payloadDigest: string;
  beginOffset: number;
  endOffset: number;
}

export type CanonicalIndexReconcileResult =
  | { status: 'ready'; bytesRead: number; recordsRead: number }
  | { status: 'cold' | 'invalid'; reason: string };

export interface LockedJsonlWriter {
  reconcileCanonicalIndex(limits?: {
    maxBytes: number;
    maxRecords: number;
  }): CanonicalIndexReconcileResult;
  getTurnHead(sessionId: string, turnKey: string): CanonicalTurnHead | undefined;
  getOrCreateTurnSequence(runtime: HookRuntime, sessionId: string, pendingKey: string): number;
  allocateTurnSequenceRange(runtime: HookRuntime, sessionId: string, count: number): number[];
  reserveObservationSequence(runtime: HookRuntime, sessionId: string): number;
  getSessionEpoch(sessionId: string): number;
  allocateSessionEpoch(sessionId: string): number;
  appendPrepared(transaction: SerializedJsonlTransaction): {
    receipt: JsonlTransactionReceipt;
    transaction: CommittedTransaction;
  };
  findCommitted(targetPath: string, txId: string, payloadDigest: string): boolean;
  applyCommittedToIndex(transaction: CommittedTransaction): void;
}

export class JsonlTransactionWriter {
  private lockDb: Database.Database;

  constructor(private readonly jsonlDir: string) {
    ensureJsonlDir(jsonlDir);
    const lockDbPath = path.join(jsonlDir, WRITER_LOCK_DB);
    fs.mkdirSync(path.dirname(lockDbPath), { recursive: true });
    assertPrivateFileTarget(lockDbPath);
    assertPrivateFileTarget(`${lockDbPath}-wal`);
    assertPrivateFileTarget(`${lockDbPath}-shm`);
    const lockDb = new Database(lockDbPath);
    try {
      lockDb.pragma('journal_mode = WAL');
      lockDb.pragma('busy_timeout = 5000');
      lockDb.exec(COORDINATION_SCHEMA);
      enforcePrivateFile(lockDbPath);
      enforcePrivateFile(`${lockDbPath}-wal`);
      enforcePrivateFile(`${lockDbPath}-shm`);
    } catch (error: unknown) {
      lockDb.close();
      throw error;
    }
    this.lockDb = lockDb;
  }

  withExclusiveTransaction<T>(operation: (writer: LockedJsonlWriter) => T): T {
    const impl = new LockedJsonlWriterImpl(this.lockDb, this.jsonlDir);
    return this.lockDb.transaction(() => operation(impl))();
  }

  close(): void {
    this.lockDb.close();
  }
}

function writeAllSync(fd: number, data: string): void {
  const buffer = Buffer.from(data, 'utf-8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error(`writeSync returned ${written}`);
    offset += written;
  }
}

function writeBufferAllSync(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error(`writeSync returned ${written}`);
    offset += written;
  }
}

function readRangeSync(fd: number, buffer: Buffer, length: number, position: number): number {
  let total = 0;
  while (total < length) {
    const bytesRead = fs.readSync(fd, buffer, total, length - total, position + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}

function findLastNewlineOffset(fd: number, fileSize: number): number {
  const buffer = Buffer.allocUnsafe(FILE_SCAN_BLOCK_BYTES);
  let position = fileSize;
  while (position > 0) {
    const length = Math.min(buffer.length, position);
    position -= length;
    const bytesRead = readRangeSync(fd, buffer, length, position);
    const index = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (index !== -1) return position + index;
  }
  return -1;
}

function copyFileRange(sourceFd: number, targetFd: number, start: number, end: number): void {
  const buffer = Buffer.allocUnsafe(FILE_SCAN_BLOCK_BYTES);
  let position = start;
  while (position < end) {
    const length = Math.min(buffer.length, end - position);
    const bytesRead = readRangeSync(sourceFd, buffer, length, position);
    if (bytesRead <= 0) throw new Error('Unexpected EOF while preserving corrupt JSONL tail');
    writeBufferAllSync(targetFd, buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

function repairPartialTail(filePath: string): void {
  assertPrivateFileTarget(filePath);
  const fd = fs.openSync(filePath, fs.constants.O_RDWR | noFollowFlag());
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize === 0) return;
    const lastNewline = findLastNewlineOffset(fd, fileSize);
    if (lastNewline === fileSize - 1) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = randomBytes(4).toString('hex');
    const sidecarPath = `${filePath}.corrupt-${timestamp}-${rand}`;

    const sidecarFd = fs.openSync(sidecarPath, 'wx', 0o600);
    try {
      copyFileRange(fd, sidecarFd, lastNewline + 1, fileSize);
      fs.fsyncSync(sidecarFd);
    } finally {
      fs.closeSync(sidecarFd);
    }

    const truncateAt = lastNewline + 1;
    fs.ftruncateSync(fd, truncateAt);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function getFileIdentity(filePath: string): string | undefined {
  try {
    assertPrivateFileTarget(filePath);
    const stat = fs.lstatSync(filePath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

class LockedJsonlWriterImpl implements LockedJsonlWriter {
  private stmts: {
    getTurnHead: Database.Statement;
    upsertTurnHead: Database.Statement;
    getSequence: Database.Statement;
    upsertSequence: Database.Statement;
    getMaxSequence: Database.Statement;
    getObsSeq: Database.Statement;
    upsertObsSeq: Database.Statement;
    getEpoch: Database.Statement;
    upsertEpoch: Database.Statement;
    getReplay: Database.Statement;
    upsertReplay: Database.Statement;
    getCommitted: Database.Statement;
    upsertCommitted: Database.Statement;
    deleteCommittedByFile: Database.Statement;
    getCommitScanState: Database.Statement;
    upsertCommitScanState: Database.Statement;
  };

  constructor(
    private db: Database.Database,
    private jsonlDir: string
  ) {
    this.stmts = {
      getTurnHead: db.prepare(
        'SELECT session_id, turn_key, history_epoch, revision, content_hash, observed_through, source_order FROM turn_heads WHERE session_id = ? AND turn_key = ?'
      ),
      upsertTurnHead: db.prepare(`
        INSERT INTO turn_heads (session_id, turn_key, history_epoch, revision, content_hash, observed_through, source_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, turn_key) DO UPDATE SET
          history_epoch = excluded.history_epoch,
          revision = excluded.revision,
          content_hash = excluded.content_hash,
          observed_through = excluded.observed_through,
          source_order = excluded.source_order
      `),
      getSequence: db.prepare(
        'SELECT sequence FROM turn_sequences WHERE runtime = ? AND session_id = ? AND pending_key = ?'
      ),
      upsertSequence: db.prepare(`
        INSERT INTO turn_sequences (runtime, session_id, pending_key, sequence)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(runtime, session_id, pending_key) DO NOTHING
      `),
      getMaxSequence: db.prepare(
        'SELECT MAX(sequence) as max_seq FROM turn_sequences WHERE runtime = ? AND session_id = ?'
      ),
      getObsSeq: db.prepare(
        'SELECT next_sequence FROM observation_sequences WHERE runtime = ? AND session_id = ?'
      ),
      upsertObsSeq: db.prepare(`
        INSERT INTO observation_sequences (runtime, session_id, next_sequence)
        VALUES (?, ?, ?)
        ON CONFLICT(runtime, session_id) DO UPDATE SET next_sequence = excluded.next_sequence
      `),
      getEpoch: db.prepare('SELECT epoch FROM session_epochs WHERE session_id = ?'),
      upsertEpoch: db.prepare(`
        INSERT INTO session_epochs (session_id, epoch) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET epoch = MAX(session_epochs.epoch, excluded.epoch)
      `),
      getReplay: db.prepare(
        'SELECT file_identity, file_size, replay_offset, hash_chain FROM file_replay_offsets WHERE file_path = ?'
      ),
      upsertReplay: db.prepare(`
        INSERT INTO file_replay_offsets (file_path, file_identity, file_size, replay_offset, hash_chain)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          file_identity = excluded.file_identity,
          file_size = excluded.file_size,
          replay_offset = excluded.replay_offset,
          hash_chain = excluded.hash_chain
      `),
      getCommitted: db.prepare(
        'SELECT payload_digest FROM committed_transactions WHERE file_path = ? AND tx_id = ?'
      ),
      upsertCommitted: db.prepare(`
        INSERT INTO committed_transactions (file_path, tx_id, payload_digest)
        VALUES (?, ?, ?)
        ON CONFLICT(file_path, tx_id) DO UPDATE SET payload_digest = excluded.payload_digest
      `),
      deleteCommittedByFile: db.prepare('DELETE FROM committed_transactions WHERE file_path = ?'),
      getCommitScanState: db.prepare(
        'SELECT file_identity, file_size, mtime_ms, ctime_ms FROM file_commit_scan_state WHERE file_path = ?'
      ),
      upsertCommitScanState: db.prepare(`
        INSERT INTO file_commit_scan_state (file_path, file_identity, file_size, mtime_ms, ctime_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          file_identity = excluded.file_identity,
          file_size = excluded.file_size,
          mtime_ms = excluded.mtime_ms,
          ctime_ms = excluded.ctime_ms
      `),
    };
  }

  reconcileCanonicalIndex(limits?: {
    maxBytes: number;
    maxRecords: number;
  }): CanonicalIndexReconcileResult {
    // ponytail: delta reconciliation stub; full impl in Task 13
    void limits;
    return { status: 'ready', bytesRead: 0, recordsRead: 0 };
  }

  getTurnHead(sessionId: string, turnKey: string): CanonicalTurnHead | undefined {
    const row = this.stmts.getTurnHead.get(sessionId, turnKey) as
      | {
          session_id: string;
          turn_key: string;
          history_epoch: number;
          revision: number;
          content_hash: string;
          observed_through: string;
          source_order: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      turnKey: row.turn_key,
      historyEpoch: row.history_epoch,
      revision: row.revision,
      contentHash: row.content_hash,
      observedThrough: JSON.parse(row.observed_through) as ObservationBoundaryV2,
      sourceOrder: row.source_order,
    };
  }

  getOrCreateTurnSequence(runtime: HookRuntime, sessionId: string, pendingKey: string): number {
    const existing = this.stmts.getSequence.get(runtime, sessionId, pendingKey) as
      | { sequence: number }
      | undefined;
    if (existing) return existing.sequence;

    const maxRow = this.stmts.getMaxSequence.get(runtime, sessionId) as {
      max_seq: number | null;
    };
    const next = (maxRow.max_seq ?? 0) + 1;
    this.stmts.upsertSequence.run(runtime, sessionId, pendingKey, next);
    return next;
  }

  allocateTurnSequenceRange(runtime: HookRuntime, sessionId: string, count: number): number[] {
    const maxRow = this.stmts.getMaxSequence.get(runtime, sessionId) as {
      max_seq: number | null;
    };
    const start = (maxRow.max_seq ?? 0) + 1;
    const result: number[] = [];
    for (let i = 0; i < count; i++) {
      result.push(start + i);
      this.stmts.upsertSequence.run(runtime, sessionId, `__range_${start + i}`, start + i);
    }
    return result;
  }

  reserveObservationSequence(runtime: HookRuntime, sessionId: string): number {
    const row = this.stmts.getObsSeq.get(runtime, sessionId) as
      | { next_sequence: number }
      | undefined;
    const seq = row?.next_sequence ?? 1;
    this.stmts.upsertObsSeq.run(runtime, sessionId, seq + 1);
    return seq;
  }

  getSessionEpoch(sessionId: string): number {
    const row = this.stmts.getEpoch.get(sessionId) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  allocateSessionEpoch(sessionId: string): number {
    const current = this.getSessionEpoch(sessionId);
    const next = current + 1;
    this.stmts.upsertEpoch.run(sessionId, next);
    return next;
  }

  appendPrepared(transaction: SerializedJsonlTransaction): {
    receipt: JsonlTransactionReceipt;
    transaction: CommittedTransaction;
  } {
    const { targetPath, txId, payloadDigest, allLines } = transaction;
    assertPrivateFileTarget(targetPath);

    if (this.findCommitted(targetPath, txId, payloadDigest)) {
      const stat = fs.statSync(targetPath);
      return {
        receipt: {
          status: 'already_committed',
          targetPath,
          txId,
          payloadDigest,
          beginOffset: 0,
          endOffset: stat.size,
        },
        transaction: {
          txId,
          createdAt: transaction.createdAt,
          filePath: targetPath,
          beginOffset: 0,
          endOffset: stat.size,
          payloadDigest,
          payloads: transaction.records.filter(
            (r) => r.type === 'session_reset' || r.type === 'turn_checkpoint'
          ) as JsonlV2Payload[],
        },
      };
    }

    const isNew = !fs.existsSync(targetPath);
    if (!isNew) {
      repairPartialTail(targetPath);
    }

    const stat = isNew ? undefined : fs.statSync(targetPath);
    const beginOffset = stat?.size ?? 0;

    const data = allLines.join('\n') + '\n';
    const fd = openPrivateFileForAppend(targetPath);
    try {
      writeAllSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    enforcePrivateFile(targetPath);

    if (isNew) {
      try {
        const dirFd = fs.openSync(path.dirname(targetPath), 'r');
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        /* ignore on platforms without directory fsync */
      }
    }

    const endOffset = beginOffset + Buffer.byteLength(data, 'utf-8');

    const payloads = transaction.records.filter(
      (r) => r.type === 'session_reset' || r.type === 'turn_checkpoint'
    ) as JsonlV2Payload[];

    const committed: CommittedTransaction = {
      txId,
      createdAt: transaction.createdAt,
      filePath: targetPath,
      beginOffset,
      endOffset,
      payloadDigest,
      payloads,
    };

    return {
      receipt: { status: 'inserted', targetPath, txId, payloadDigest, beginOffset, endOffset },
      transaction: committed,
    };
  }

  findCommitted(targetPath: string, txId: string, payloadDigest: string): boolean {
    assertPrivateFileTarget(targetPath);
    if (!fs.existsSync(targetPath)) return false;

    const current = getFileSnapshot(targetPath);
    const scanState = this.stmts.getCommitScanState.get(targetPath) as
      | { file_identity: string; file_size: number; mtime_ms: number; ctime_ms: number }
      | undefined;
    if (scanState) {
      const indexed: FileSnapshot = {
        identity: scanState.file_identity,
        size: scanState.file_size,
        mtimeMs: scanState.mtime_ms,
        ctimeMs: scanState.ctime_ms,
      };
      if (sameSnapshot(current, indexed)) {
        const cached = this.stmts.getCommitted.get(targetPath, txId) as
          | { payload_digest: string }
          | undefined;
        if (!cached) return false;
        if (cached.payload_digest !== payloadDigest) {
          throw new Error(`Transaction ID ${txId} is already committed with a different payload`);
        }
        return true;
      }
    }

    this.stmts.deleteCommittedByFile.run(targetPath);
    let active:
      | {
          txId: string;
          recordCount: number;
          valid: boolean;
          digest: ReturnType<typeof createHash>;
        }
      | undefined;

    const scanned = forEachPrivateFileLine(targetPath, (line) => {
      if (line === undefined) {
        if (active) throw new Error(`JSONL transaction record exceeds safe scan limit`);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        if (active) active.valid = false;
        return;
      }

      if (isJsonlV2Record(parsed) && parsed.type === 'tx_begin') {
        active = {
          txId: parsed.txId,
          recordCount: 0,
          valid: true,
          digest: createHash('sha256'),
        };
        return;
      }

      if (isJsonlV2Record(parsed) && parsed.type === 'tx_commit') {
        if (!active) return;
        const digest = active.digest.digest('hex');
        if (
          active.valid &&
          parsed.txId === active.txId &&
          parsed.recordCount === active.recordCount &&
          parsed.payloadDigest === digest
        ) {
          const cached = this.stmts.getCommitted.get(targetPath, parsed.txId) as
            | { payload_digest: string }
            | undefined;
          if (cached && cached.payload_digest !== parsed.payloadDigest) {
            throw new Error(
              `Transaction ID ${parsed.txId} is already committed with a different payload`
            );
          }
          this.stmts.upsertCommitted.run(targetPath, parsed.txId, parsed.payloadDigest);
        }
        active = undefined;
        return;
      }

      if (!active) return;
      active.digest.update(line, 'utf-8').update('\n', 'utf-8');
      active.recordCount++;
      if (!isJsonlV2Payload(parsed) || parsed.txId !== active.txId) active.valid = false;
    });

    const afterScan = getFileSnapshot(targetPath);
    if (!sameSnapshot(scanned, afterScan)) {
      throw new Error('JSONL file changed while indexing transactions');
    }
    this.stmts.upsertCommitScanState.run(
      targetPath,
      scanned.identity,
      scanned.size,
      scanned.mtimeMs,
      scanned.ctimeMs
    );

    const cached = this.stmts.getCommitted.get(targetPath, txId) as
      | { payload_digest: string }
      | undefined;
    if (!cached) return false;
    if (cached.payload_digest !== payloadDigest) {
      throw new Error(`Transaction ID ${txId} is already committed with a different payload`);
    }
    return true;
  }

  applyCommittedToIndex(transaction: CommittedTransaction): void {
    const cached = this.stmts.getCommitted.get(transaction.filePath, transaction.txId) as
      | { payload_digest: string }
      | undefined;
    if (cached && cached.payload_digest !== transaction.payloadDigest) {
      throw new Error(
        `Transaction ID ${transaction.txId} is already committed with a different payload`
      );
    }
    this.stmts.upsertCommitted.run(
      transaction.filePath,
      transaction.txId,
      transaction.payloadDigest
    );

    for (const payload of transaction.payloads) {
      if (payload.type === 'session_reset') {
        this.stmts.upsertEpoch.run(payload.sessionId, payload.historyEpoch);
      } else if (
        shouldAdvanceTurnHead(this.getTurnHead(payload.sessionId, payload.turnKey), payload)
      ) {
        this.stmts.upsertTurnHead.run(
          payload.sessionId,
          payload.turnKey,
          payload.historyEpoch,
          payload.revision,
          payload.contentHash,
          JSON.stringify(payload.observedThrough),
          payload.sourceOrder
        );
      }
    }

    const identity = getFileIdentity(transaction.filePath);
    if (identity) {
      const snapshot = getFileSnapshot(transaction.filePath);
      const chainInput = `${transaction.txId}:${transaction.payloadDigest}:${transaction.endOffset}`;
      const hashChain = createHash('sha256').update(chainInput).digest('hex');
      this.stmts.upsertReplay.run(
        transaction.filePath,
        identity,
        transaction.endOffset,
        transaction.endOffset,
        hashChain
      );
      if (snapshot.identity === identity && snapshot.size === transaction.endOffset) {
        this.stmts.upsertCommitScanState.run(
          transaction.filePath,
          snapshot.identity,
          snapshot.size,
          snapshot.mtimeMs,
          snapshot.ctimeMs
        );
      }
    }
  }
}
