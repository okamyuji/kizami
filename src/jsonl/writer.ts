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
import type { HookRuntime, ObservationBoundaryV2 } from '@/checkpoint/types';

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

    const fd = fs.openSync(filePath, 'a');
    try {
      fs.writeSync(fd, lines);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
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
    this.lockDb = new Database(lockDbPath);
    this.lockDb.pragma('journal_mode = WAL');
    this.lockDb.pragma('busy_timeout = 5000');
    this.lockDb.exec(COORDINATION_SCHEMA);
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

function repairPartialTail(filePath: string): void {
  const content = fs.readFileSync(filePath);
  if (content.length === 0) return;
  if (content[content.length - 1] === 0x0a) return;

  const lastNewline = content.lastIndexOf(0x0a);
  const corruptBytes = lastNewline === -1 ? content : content.subarray(lastNewline + 1);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(4).toString('hex');
  const sidecarPath = `${filePath}.corrupt-${timestamp}-${rand}`;

  const sfd = fs.openSync(sidecarPath, 'wx');
  try {
    fs.writeSync(sfd, corruptBytes);
    fs.fsyncSync(sfd);
  } finally {
    fs.closeSync(sfd);
  }

  const truncateAt = lastNewline === -1 ? 0 : lastNewline + 1;
  fs.truncateSync(filePath, truncateAt);
  const mfd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(mfd);
  } finally {
    fs.closeSync(mfd);
  }
}

function getFileIdentity(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
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
        ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch
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
    const fd = fs.openSync(targetPath, 'a');
    try {
      writeAllSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

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
    if (!fs.existsSync(targetPath)) return false;

    const content = fs.readFileSync(targetPath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('"tx_commit"') || !line.includes(txId)) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (
          parsed.v === 2 &&
          parsed.type === 'tx_commit' &&
          parsed.txId === txId &&
          parsed.payloadDigest === payloadDigest
        ) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  applyCommittedToIndex(transaction: CommittedTransaction): void {
    for (const payload of transaction.payloads) {
      if (payload.type === 'turn_checkpoint') {
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
      const chainInput = `${transaction.txId}:${transaction.payloadDigest}:${transaction.endOffset}`;
      const hashChain = createHash('sha256').update(chainInput).digest('hex');
      this.stmts.upsertReplay.run(
        transaction.filePath,
        identity,
        transaction.endOffset,
        transaction.endOffset,
        hashChain
      );
    }
  }
}
