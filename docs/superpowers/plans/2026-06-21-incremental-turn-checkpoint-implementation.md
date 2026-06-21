# Incremental Turn Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each supported runtime's current completed turn before session termination, using local deterministic chunking and crash-safe revisioned JSONL checkpoints.

**Architecture:** Add a v2 transaction protocol to the append-only JSONL source of truth, fold revisions into canonical turns, and materialize them into a schema-v4 SQLite cache. Runtime adapters convert Claude, Codex, and supported Kimi event streams into stable turn candidates; a coordinator commits content first and advances pending/cursor state only after durable success.

**Tech Stack:** Node.js 24.14.1, TypeScript 5.9, better-sqlite3 12.8, Vitest 4.1, existing Kizami JSONL/SQLite/FTS5 infrastructure.

## Global Constraints

- Do not call an external AI service or add an LLM summarizer.
- Preserve the existing deterministic 512-token chunking and tool-output truncation behavior.
- JSONL remains authoritative; SQLite and vector embeddings remain rebuildable derived state.
- New v2 writes must not use the legacy full-session `insertChunks` replacement path.
- Core FTS content must be durable and searchable when a successful Stop hook returns.
- Embedding failure or timeout must not fail core checkpoint persistence.
- Unknown, incomplete, truncated, or unsupported runtime data must fail open without cursor advancement or pending deletion.
- Preserve unrelated user hooks and remove historical Kizami hooks only through the strict ownership classifier specified in Task 14.
- Retain v1 JSONL reading, migration, import, and self-heal compatibility.
- All shell commands in this repository must be prefixed with `rtk`.
- Design authority: `docs/superpowers/specs/2026-06-21-incremental-turn-checkpoint-design.md`.

## Fixed Serialization Rules

- `recordCount` counts payload records only; it excludes `tx_begin` and `tx_commit`.
- `payloadDigest` is SHA-256 over the UTF-8 bytes of `payloadLines.join('\n') + '\n'`.
- Hash inputs use length-prefixed UTF-8 fields, never delimiter-only concatenation.
- Every transaction `txId` is SHA-256 of `sessionId`, optional literal `legacy_reset`, allocated `historyEpoch`, and the complete lexically sorted tuple list `(turnKey, revision, contentHash)`. A one-turn checkpoint is the one-element form of the same formula.
- Legacy baseline uses that batch formula and additionally includes literal `legacy_reset`; reset and non-reset transactions cannot collide.
- Every prompt capture atomically reserves a session-local turn sequence. `sourceOrder` is that sequence encoded as 20 decimal digits for every runtime; runtime IDs and file identities are never ordering keys.
- Every Stop/SessionEnd invocation atomically reserves its observation boundary before parsing. Claude/Kimi use `{kind:'source_offset', generation, offset}` after extraction; Codex uses `{kind:'delivery_sequence', sequence}` for every invocation, whether or not `turn_id` exists.
- The writer-lock database is a derived canonical index containing turn heads, session epochs, runtime sequences, and per-file replay offsets. Setup/rebuild creates it; Stop performs delta reconciliation only and defers if a cold index rebuild is required.
- State roots are `<db-dir>/pending/<runtime>/`, `<db-dir>/prepared/<runtime>/`, and `<db-dir>/cursors/<runtime>/`. Filenames use SHA-256 identifiers, never raw session IDs.
- `fromMonth` rebuild filtering performs a full canonical fold and filters reporting only; it must not truncate and rebuild from an incomplete history subset.

---

## File Responsibility Map

### New files

- `src/checkpoint/types.ts`: shared domain types and result unions.
- `src/checkpoint/identity.ts`: length-prefixed hashes and stable identities.
- `src/checkpoint/builder.ts`: existing-rule turn-to-parts conversion.
- `src/checkpoint/state.ts`: durable pending, prepared, and cursor files.
- `src/checkpoint/coordinator.ts`: revision allocation, commit, recovery, and finalization.
- `src/checkpoint/service.ts`: runtime-neutral hook entrypoints.
- `src/checkpoint/adapter.ts`: runtime adapter interface.
- `src/checkpoint/adapters/claude.ts`: Claude payload parsing and transcript extraction.
- `src/checkpoint/adapters/codex.ts`: Codex payload parsing and turn extraction.
- `src/checkpoint/adapters/kimi.ts`: Kimi payload parsing and versioned wire state machine.
- `src/jsonl/transaction.ts`: v2 transaction serialization and validation.
- `src/jsonl/fold.ts`: v1/v2 canonical history fold.
- `src/hooks/ownership.ts`: strict Kizami lifecycle command ownership classification.
- Tests mirroring each new module under `tests/checkpoint/`, `tests/jsonl/`, and `tests/hooks/`.

### Modified files

- `src/parser/transcript.ts`, `src/parser/chunker.ts`: expose raw offsets and reusable turn chunking.
- `src/jsonl/types.ts`, `writer.ts`, `reader.ts`, `rebuild.ts`: v2 records, transaction writer, canonical reader, fold-based rebuild.
- `src/db/schema.ts`, `connection.ts`, `store.ts`: schema v4 and revision materialization.
- `src/hooks/recall.ts`, `save.ts`, `recover.ts`, `codex.ts`, `kimi.ts`, `setup.ts`, `toml.ts`: adapter wiring and hook migration.
- `src/cli.ts`, `README.md`, `CHANGELOG.md`: command/help and behavior documentation.

---

### Task 1: Freeze sanitized runtime contracts

**Files:**

- Create: `tests/fixtures/hooks/README.md`
- Create: `tests/fixtures/hooks/claude/*.json`
- Create: `tests/fixtures/hooks/claude/*.jsonl`
- Create: `tests/fixtures/hooks/codex-0.141.0/*.json`
- Create: `tests/fixtures/hooks/kimi-0.18.0/*.json`
- Create: `tests/fixtures/hooks/kimi-0.18.0/*.jsonl`
- Create: `tests/checkpoint/runtime-contracts.test.ts`

**Interfaces:**

- Consumes: installed Claude Code 2.1.185, Codex CLI 0.141.0, and Kimi Code 0.18.0 payloads.
- Produces: secret-free immutable fixtures used by Tasks 10–12.

- [ ] **Step 1: Capture fixture shapes without copying private content**

Retain event names, record IDs, parent IDs, offsets, completion events, tool event structure, and field types. Replace prompt, response, paths, account values, tokens, and IDs with deterministic test values. Document each substitution in `tests/fixtures/hooks/README.md`.

Required Claude cases: prompt UUID present/absent, Stop continuation, tool use/result, compact boundary, partial final line, and SessionEnd. Required Codex cases: turn ID present/absent, changed assistant content, missing assistant, and unknown fields. Required Kimi cases: string/array prompt, user event, step begin, text/tool parts, explicit completion, multiple steps, partial line, unknown schema, truncation, and rotation replay.

- [ ] **Step 2: Add and run a fixture contract test**

`tests/checkpoint/runtime-contracts.test.ts` must parse every JSON/JSONL fixture, assert required event fields and complete lines, scan every string value for the original home directory, credential key names, bearer/API-key patterns, and verify whether the Kimi fixture contains the documented explicit completion boundary. Fixtures must come from observed payloads; if an installed runtime/version cannot be inspected and no committed fixture exists, stop and report the corresponding adapter task blocked rather than inventing a schema.

Run:

```bash
rtk pnpm secretlint
rtk pnpm exec vitest run tests/checkpoint/runtime-contracts.test.ts tests/parser/transcript.test.ts tests/hooks/codex.test.ts tests/hooks/kimi.test.ts
```

Expected: secret scan passes; existing tests pass unchanged. This is a baseline run against pre-modification state; later tasks (10, 11, 12) will modify `transcript.test.ts`, `codex.test.ts`, and `kimi.test.ts`. If Kimi 0.18.0 has no unambiguous completion event, record `kimiStopSupported: false` in its fixture README and retain SessionEnd-only fail-safe behavior in Task 12.

- [ ] **Step 3: Commit**

```bash
rtk git add tests/fixtures/hooks tests/checkpoint/runtime-contracts.test.ts
rtk git commit -m "test: freeze runtime hook payload fixtures"
```

---

### Task 2: Add shared checkpoint identities and part builder

**Files:**

- Create: `src/checkpoint/types.ts`
- Create: `src/checkpoint/identity.ts`
- Create: `src/checkpoint/builder.ts`
- Create: `tests/checkpoint/identity.test.ts`
- Create: `tests/checkpoint/builder.test.ts`
- Modify: `src/parser/chunker.ts`
- Test: `tests/parser/chunker.test.ts`

**Interfaces:**

- Consumes: `TranscriptMessage[]`, existing `Chunk` role/metadata, existing chunk size and truncation rules.
- Produces: `TurnCheckpointCandidate`, stable `turnKey`, stable part external IDs, and `TurnPartV2[]`.

- [ ] **Step 1: Write failing identity and multi-part tests**

```ts
it('keeps part identity stable across content revisions', () => {
  const turnKey = createTurnKey('claude', 's1', 'uuid:u1');
  expect(createPartExternalId('claude', 's1', turnKey, 0)).toBe(
    createPartExternalId('claude', 's1', turnKey, 0)
  );
  expect(createPartExternalId('claude', 's1', turnKey, 0)).not.toBe(
    createPartExternalId('claude', 's1', turnKey, 1)
  );
});

it('distinguishes identical prompts at different source records', () => {
  expect(createTurnKey('claude', 's1', 'offset:0001')).not.toBe(
    createTurnKey('claude', 's1', 'offset:0099')
  );
});

it('splits one long turn with stable sequential part indices', () => {
  const parts = buildCheckpointParts(makeCandidate('paragraph\n\n'.repeat(600)));
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.map((part) => part.partIndex)).toEqual(parts.map((_, index) => index));
});
```

Run: `rtk pnpm exec vitest run tests/checkpoint/identity.test.ts tests/checkpoint/builder.test.ts`  
Expected: FAIL because the modules do not exist.

- [ ] **Step 2: Define the exact shared types**

Implement these exported shapes in `src/checkpoint/types.ts`:

```ts
export type HookRuntime = 'claude' | 'codex' | 'kimi';

export interface SourceAnchorV2 {
  path?: string;
  fileIdentity?: string;
  byteLength?: number;
  promptRecordOffset?: number;
  // Plan addition beyond spec Section 4.1: stores the resolved Claude transcript
  // record UUID or Kimi wire user-event ID. Used to compute pendingKey and turnKey
  // once the source record is resolved at Stop time. The file-identity+offset
  // fallback in pendingKey applies only when this field is absent.
  promptRecordId?: string;
}

export interface PendingPromptV2 {
  version: 2;
  runtime: HookRuntime;
  sessionId: string;
  runtimeTurnId?: string;
  projectPath: string;
  prompt: string;
  model?: string;
  source: SourceAnchorV2;
  pendingKey: string;
  turnSequence: number;
  sourceOrder: string;
  createdAt: string;
}

export interface TurnPartV2 {
  partIndex: number;
  externalId: string;
  content: string;
  role: 'human' | 'assistant' | 'mixed';
  metadata: import('@/db/store').Chunk['metadata'];
  tokenCount: number;
}

export interface TurnCheckpointCandidate {
  runtime: HookRuntime;
  sessionId: string;
  turnKey: string;
  sourceOrder: string;
  observedThrough: ObservationBoundaryV2;
  projectPath: string;
  completedAt: string;
  prompt: string;
  assistant: string;
  messages: import('@/parser/transcript').TranscriptMessage[];
  model?: string;
}

export interface TurnCheckpointV2 {
  sessionId: string;
  runtime: HookRuntime;
  turnKey: string;
  sourceOrder: string;
  observedThrough: ObservationBoundaryV2;
  historyEpoch: number;
  revision: number;
  contentHash: string;
  completedAt: string;
  projectPath: string;
  parts: TurnPartV2[];
}

export type ObservationBoundaryV2 =
  | { kind: 'source_offset'; generation: number; offset: number }
  | { kind: 'delivery_sequence'; sequence: number };

export type CheckpointCommitStatus =
  | 'inserted'
  | 'already_current'
  | 'stale'
  | 'conflict'
  | 'deferred';

export interface CheckpointCommitResult {
  status: CheckpointCommitStatus;
  turnKey: string;
  revision?: number;
  txId?: string;
  reason?: string;
}
```

- [ ] **Step 3: Implement length-prefixed identities and reusable chunking**

Export:

```ts
export function hashFields(...fields: Array<string | number>): string;
export function createTurnKey(
  runtime: HookRuntime,
  sessionId: string,
  sourceIdentity: string
): string;
export function createPartExternalId(
  runtime: HookRuntime,
  sessionId: string,
  turnKey: string,
  partIndex: number
): string;
export function createContentHash(
  prompt: string,
  assistant: string,
  toolResults: string[],
  parts: TurnPartV2[]
): string;
export function compareObservationBoundary(
  left: ObservationBoundaryV2,
  right: ObservationBoundaryV2
): 'older' | 'equal' | 'newer' | 'incomparable';
export function buildCheckpointParts(candidate: TurnCheckpointCandidate): TurnPartV2[];
```

`hashFields` hashes each field as `<byteLength>:<UTF-8 bytes>`. `contentHash` covers prompt, assistant, toolResults, and every generated part; it does not cover `sourceOrder`. Boundary comparison requires the same `kind`; source offsets compare generation then offset, delivery sequences compare sequence, and different kinds are `incomparable` (which is a hard error indicating session ID collision across runtimes). Coordinator always maps `incomparable` to `conflict`, retains pending state, and never overwrites. Rotation validation belongs to the adapter before it increments generation. Store owns JSON serialization/deserialization of `observed_through`. `buildCheckpointParts` uses `candidate.messages` when non-empty (Claude); for Codex and Kimi, adapters synthesize `TranscriptMessage[]` from `candidate.prompt` and `candidate.assistant` strings so the same chunking path is used for all runtimes. Refactor `buildChunks` so both legacy session chunking and `buildCheckpointParts` call the same internal turn formatting and paragraph splitting functions. Do not copy the 512-token algorithm into a second implementation.

- [ ] **Step 4: Verify compatibility**

Run:

```bash
rtk pnpm exec vitest run tests/checkpoint/identity.test.ts tests/checkpoint/builder.test.ts tests/parser/chunker.test.ts
rtk pnpm typecheck
```

Expected: all tests pass; existing chunker snapshots remain unchanged.

- [ ] **Step 5: Commit**

```bash
rtk git add src/checkpoint src/parser/chunker.ts tests/checkpoint tests/parser/chunker.test.ts
rtk git commit -m "feat: add checkpoint identity and part builder"
```

---

### Task 3: Implement durable pending, cursor, and prepared state

**Files:**

- Create: `src/checkpoint/state.ts`
- Create: `tests/checkpoint/state.test.ts`
- Modify: `src/hooks/kimi.ts`
- Test: `tests/hooks/kimi.test.ts`

**Interfaces:**

- Consumes: `PendingPromptV2`, runtime cursors, prepared transactions.
- Produces: atomic state writes with file and directory durability; compatibility readers without age deletion.

- [ ] **Step 1: Write failing durability and retention tests**

Test mode `0600`, temp-write/fsync/rename/directory-fsync call order through an injected filesystem adapter, idempotent same-key writes, conflicting same-key quarantine, malformed JSON quarantine, and recovery of a Kimi pending file older than 24 hours.

```ts
it('retains old Kimi pending prompts until persisted or explicitly removed', () => {
  const file = writeLegacyKimiPending({ createdAt: '2020-01-01T00:00:00.000Z' });
  expect(readPendingPrompts(root, 'kimi', 'session-1')).toHaveLength(1);
  expect(fs.existsSync(file)).toBe(true);
});
```

Run: `rtk pnpm exec vitest run tests/checkpoint/state.test.ts tests/hooks/kimi.test.ts`  
Expected: FAIL because durable state APIs and no-TTL behavior do not exist.

- [ ] **Step 2: Implement the state API**

Export:

```ts
// Base cursor with optional fields. Runtime-specific subtypes (e.g. KimiCursorV2
// in Task 12) make certain fields required via interface extension. Code receiving
// a generic RuntimeCursorV2 must narrow to the runtime-specific subtype before
// accessing fields that the subtype requires.
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
  records: import('@/jsonl/types').JsonlV2Record[];
  turnKeys: string[];
  finalization: {
    pendingPaths: string[];
    cursorPath?: string;
    cursorAfter?: RuntimeCursorV2;
  };
}

export function writeDurableJson<T>(filePath: string, value: T, mode?: number): void;
export function writePendingPrompt(stateRoot: string, pending: PendingPromptV2): string;
export function readPendingPrompts(
  stateRoot: string,
  runtime: HookRuntime,
  sessionId: string
): PendingPromptV2[];
export function writePreparedCheckpoint(stateRoot: string, value: PreparedCheckpointV2): string;
export function updatePreparedPhase(filePath: string, phase: PreparedCheckpointV2['phase']): void;
export function writeRuntimeCursor(
  stateRoot: string,
  runtime: HookRuntime,
  sessionId: string,
  cursor: RuntimeCursorV2
): void;
export function quarantineMalformedState(filePath: string, reason: string): string;
export function removePendingPrompt(filePath: string): void;
export function finalizePreparedCheckpoint(filePath: string): void;
export function markPreparedSuperseded(filePath: string, reason: string): void;
```

`writeDurableJson` must write all bytes, `fsync` the temporary file, close, rename in the same directory, open and `fsync` the parent directory, and clean only its own abandoned temporary path on failure. `updatePreparedPhase` must use the same `writeDurableJson` atomic-rename pattern as the initial write; in-place JSON editing is prohibited because a crash mid-write would corrupt the receipt and make the exact phase unrecoverable.

- [ ] **Step 3: Remove Kimi's age-only deletion**

Delete `PENDING_TTL_MS` filtering. Keep legacy parsing, but route successful reads into normalized `PendingPromptV2`. Cleanup occurs only after coordinator success or explicit maintenance.

- [ ] **Step 4: Verify**

Run:

```bash
rtk pnpm exec vitest run tests/checkpoint/state.test.ts tests/hooks/kimi.test.ts
rtk pnpm typecheck
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
rtk git add src/checkpoint/state.ts src/hooks/kimi.ts tests/checkpoint/state.test.ts tests/hooks/kimi.test.ts
rtk git commit -m "feat: persist checkpoint state atomically"
```

---

### Task 4: Add JSONL v2 transaction serialization

**Files:**

- Modify: `src/jsonl/types.ts`
- Create: `src/jsonl/transaction.ts`
- Create: `tests/jsonl/transaction.test.ts`

**Interfaces:**

- Consumes: `TurnCheckpointV2` and optional session reset payload.
- Produces: exact transaction lines, digest, and validation result.

- [ ] **Step 1: Write failing protocol tests**

Verify payload-only `recordCount`, exact newline-inclusive digest, invalid digest rejection, incomplete transaction rejection, and stable serialization.

Run: `rtk pnpm exec vitest run tests/jsonl/transaction.test.ts`  
Expected: FAIL because v2 records do not exist.

- [ ] **Step 2: Define v2 records and serializer**

Keep `JsonlChunkRecord` as a v1-compatible exported alias and add:

```ts
export type JsonlV2Payload =
  | {
      v: 2;
      type: 'session_reset';
      txId: string;
      sessionId: string;
      historyEpoch: number;
      reason: 'legacy_mismatch';
    }
  | ({ v: 2; type: 'turn_checkpoint'; txId: string } & TurnCheckpointV2);

export type JsonlV2Record =
  | { v: 2; type: 'tx_begin'; txId: string; createdAt: string }
  | JsonlV2Payload
  | {
      v: 2;
      type: 'tx_commit';
      txId: string;
      recordCount: number;
      payloadDigest: string;
      createdAt: string;
    };

export interface SerializedJsonlTransaction {
  txId: string;
  createdAt: string;
  targetPath: string;
  payloadLines: string[];
  payloadDigest: string;
  allLines: string[];
  records: JsonlV2Record[];
}

export type JsonlRecord = JsonlChunkRecord | JsonlV2Record;

export interface CommittedTransaction {
  txId: string;
  createdAt: string;
  filePath: string;
  beginOffset: number;
  endOffset: number;
  payloadDigest: string;
  payloads: JsonlV2Payload[];
}

export interface ValidatedTransactionFrame {
  txId: string;
  createdAt: string;
  payloadDigest: string;
  payloads: JsonlV2Payload[];
}

export type JsonlLineResult =
  | { kind: 'record'; offset: number; endOffset: number; line: string; record: JsonlRecord }
  | { kind: 'diagnostic'; offset: number; endOffset: number; line: string; message: string };

export type CanonicalTransactionResult =
  | { kind: 'transaction'; transaction: CommittedTransaction }
  | { kind: 'diagnostic'; filePath: string; offset: number; txId?: string; message: string };
```

Export:

```ts
export function serializeV2Transaction(
  payloads: JsonlV2Payload[],
  options: { txId: string; createdAt: string; targetPath: string }
): SerializedJsonlTransaction;
export function validateCommittedTransaction(
  beginLine: string,
  payloadLines: string[],
  commitLine: string
): import('@/jsonl/types').ValidatedTransactionFrame | undefined;
```

`validateCommittedTransaction` validates content only. `readCanonicalTransactions` attaches `filePath`, `beginOffset`, and `endOffset` to produce `CommittedTransaction`.

- [ ] **Step 3: Verify and commit**

```bash
rtk pnpm exec vitest run tests/jsonl/transaction.test.ts tests/jsonl/codec.test.ts
rtk pnpm typecheck
rtk git add src/jsonl/types.ts src/jsonl/transaction.ts tests/jsonl/transaction.test.ts
rtk git commit -m "feat: define JSONL v2 transactions"
```

Expected: tests and typecheck pass; commit succeeds.

---

### Task 5: Make JSONL transaction append crash-safe

**Files:**

- Modify: `src/jsonl/writer.ts`
- Modify: `src/jsonl/reader.ts`
- Create: `tests/jsonl/transaction-writer.test.ts`
- Create: `tests/jsonl/concurrent-writer.test.ts`
- Modify: `tests/perf/bench.ts`

**Interfaces:**

- Consumes: `SerializedJsonlTransaction`.
- Produces: committed or already-committed receipt under cross-process serialization.

- [ ] **Step 1: Write failing crash and concurrency tests**

Cover injected short writes, partial tail quarantine, exact transaction retry, month rollover using the persisted target path, two child processes writing different sessions, and invalid/uncommitted transaction invisibility. Include a newline-terminated `tx_begin + payload` crash followed by a complete retry with the same `txId`; the reader must diagnose exactly one abandoned-frame diagnostic and accept the second complete frame. After a retry with the same `txId`, assert the JSONL file contains the committed transaction exactly once (verify by line count or offset comparison to confirm no double-append).

Add a 100,000 JSONL-line history fixture (approximately 33,000 turn checkpoints in v2 transactions) distributed across 1,000 sessions with up to 100 turns each, spanning the current host/month file plus 10 prior month files with 1,000 lines each. Unit tests instrument file reads and assert a warm Stop reads only the appended delta from the current month file and never opens prior-month files, while deleting or invalidating the index returns a cold diagnostic without scanning the fixture. The 8-second budget includes JSONL append and SQLite apply but excludes embedding generation. The performance benchmark reports timing normally; when `KIZAMI_PERF_GATE=1` on the designated macOS/Node 24 release runner, it fails at 8 seconds, leaving margin under the 10-second hook timeout. Generic CI does not apply a wall-clock assertion.

Run: `rtk pnpm exec vitest run tests/jsonl/transaction-writer.test.ts tests/jsonl/concurrent-writer.test.ts`  
Expected: FAIL.

- [ ] **Step 2: Implement exact line reading**

Export without changing the legacy v1 reader signature:

```ts
export async function* readJsonlLines(
  filePath: string
): AsyncGenerator<JsonlLineResult>;
export async function* readCanonicalTransactions(
  filePath: string
): AsyncGenerator<CanonicalTransactionResult>;
```

Only newline-terminated lines are eligible. Invalid lines are reported to the caller's diagnostics collection instead of terminating iteration.

- [ ] **Step 3: Implement the transaction writer**

Add:

```ts
export interface JsonlTransactionReceipt {
  status: 'inserted' | 'already_committed';
  targetPath: string;
  txId: string;
  payloadDigest: string;
  beginOffset: number;
  endOffset: number;
}

export class JsonlTransactionWriter {
  constructor(private readonly jsonlDir: string) {}
  /** Synchronous only — no awaits permitted inside the callback. The SQLite
   *  BEGIN IMMEDIATE is held for the duration; an await would release the
   *  event loop and allow concurrent access before the transaction commits. */
  withExclusiveTransaction<T>(operation: (writer: LockedJsonlWriter) => T): T;
}

export interface CanonicalTurnHead {
  sessionId: string;
  turnKey: string;
  historyEpoch: number;
  revision: number;
  contentHash: string;
  observedThrough: ObservationBoundaryV2;
  sourceOrder: string;
}

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

export type CanonicalIndexReconcileResult =
  | { status: 'ready'; bytesRead: number; recordsRead: number }
  | { status: 'cold' | 'invalid'; reason: string };
```

Use a dedicated `jsonlDir/.writer-lock.sqlite` connection configured with WAL and `busy_timeout = 5000`. `withExclusiveTransaction` executes one `BEGIN IMMEDIATE` and forbids nested acquisition. It owns canonical-index reconciliation, head lookup, revision/epoch/sequence allocation, prepared receipt creation through the coordinator callback, append, and index update before commit. `LockedJsonlWriter.appendPrepared` never acquires the lock again.

The coordination database contains derived `turn_heads`/`session_epochs`, durable turn sequences keyed by pending key, durable observation sequences, and `file_replay_offsets`. Every turn head stores canonical `sourceOrder`; a later revision must reuse it instead of allocating a new order. Each replay row stores file identity, size, offset, and the hash chain `SHA-256(previousChain, txId, payloadDigest, endOffset)`. Kizami owns JSONL files as append-only; replacement/truncation or unexpected identity/stat transition returns `invalid`, and arbitrary same-inode history editing is outside the supported storage contract. Hook execution calls reconciliation with `{maxBytes: 4 * 1024 * 1024, maxRecords: 10_000}`; exceeding either returns `cold`, which the service converts to deferred.

Setup/rebuild obtains `BEGIN EXCLUSIVE` on this same database and rebuilds only canonical-head/replay tables in place. It never renames an open SQLite database or its WAL/SHM files. Preserve existing sequence counters and pending-key mappings, then raise them to maxima/mappings found in JSONL, pending, and prepared receipts. A corrupt database requires explicit offline backup/recreation and must not be replaced by a live hook.

`repairPartialTail` copies the unterminated suffix to `<jsonl>.corrupt-<UTC>-<random>`, fsyncs it, truncates the JSONL file, and fsyncs the JSONL file before append. After append, fsync the JSONL file; if the file was newly created during this write, also fsync its parent directory before committing the writer-lock transaction.

- [ ] **Step 4: Verify and commit**

```bash
rtk pnpm exec vitest run tests/jsonl/transaction-writer.test.ts tests/jsonl/concurrent-writer.test.ts tests/jsonl/writer-reader.test.ts
rtk pnpm typecheck
rtk git add src/jsonl/writer.ts src/jsonl/reader.ts tests/jsonl tests/perf/bench.ts
rtk git commit -m "feat: append JSONL transactions crash safely"
```

Expected: all writer tests pass.

---

### Task 6: Fold canonical v1/v2 history

**Files:**

- Create: `src/jsonl/fold.ts`
- Create: `tests/jsonl/fold.test.ts`

**Interfaces:**

- Consumes: ordered JSONL files containing v1 records and committed v2 transactions.
- Produces: canonical legacy chunks, latest logical turns, reset sessions, diagnostics.

- [ ] **Step 1: Write failing fold tests**

Test incomplete transaction ignore, duplicate same revision/hash dedupe, equal revision/different hash conflict, higher revision selection, obsolete-part removal, committed reset behavior, and uncommitted reset invisibility.

- [ ] **Step 2: Implement the fold contract**

```ts
export interface JsonlFoldError {
  code: 'invalid_transaction' | 'revision_conflict';
  filePath: string;
  txId?: string;
  message: string;
}

export interface CanonicalHistory {
  legacyChunks: JsonlChunkRecord[];
  turns: Map<string, TurnCheckpointV2>;
  resetSessions: Set<string>;
  errors: JsonlFoldError[];
}

export async function foldCanonicalHistory(files: string[]): Promise<CanonicalHistory>;
export async function rebuildCanonicalIndex(
  jsonlDir: string,
  files: string[],
  stateRoots: { pendingRoot: string; preparedRoot: string }
): Promise<{ filesProcessed: number; transactionsIndexed: number }>;
```

Key turns by length-prefixed `sessionId + turnKey`. Apply only digest-valid committed transactions. Sort diagnostics by `createdAt`, file path, begin offset, and txId. When any committed reset exists for a session, suppress every v1 record for that session; choose the greatest `historyEpoch` and accept only v2 checkpoints in that epoch. An equal epoch/revision with a different hash is an error and must make rebuild fail rather than choosing silently. Runtime checkpoints query all-file canonical heads through `LockedJsonlWriter.getTurnHead`, never by scanning only the new transaction's target month.

Note: `rebuildCanonicalIndex` re-folds internally rather than accepting a pre-folded result. During a full rebuild (Task 13), the fold runs twice — once for `materializeCanonicalHistory` (SQLite) and once for `rebuildCanonicalIndex` (writer-lock database). This is acceptable because rebuild is an explicit offline operation, not a hot-path hook call.

- [ ] **Step 3: Verify and commit**

```bash
rtk pnpm exec vitest run tests/jsonl/fold.test.ts
rtk pnpm typecheck
rtk git add src/jsonl/fold.ts tests/jsonl/fold.test.ts
rtk git commit -m "feat: fold canonical checkpoint history"
```

Expected: all tests pass.

---

### Task 7: Migrate SQLite to schema v4

**Files:**

- Modify: `src/db/schema.ts`
- Modify: `src/db/connection.ts`
- Modify: `src/db/store.ts`
- Test: `tests/schema.test.ts`
- Test: `tests/connection.test.ts`
- Test: `tests/store.test.ts`

**Interfaces:**

- Consumes: schema-v3 databases including FTS and optional vector mappings.
- Produces: schema v4 without canonical dependence on `session_id + chunk_index` uniqueness.
- Note: `src/db/connection.ts` already exports `openDatabase(dbPath: string): Database`. This task extends it with WAL/foreign-keys/busy_timeout pragmas but does not change its signature. The coordinator (Task 9) uses `openDatabase` to obtain the `Database` instance passed to `new Store(db)`.

- [ ] **Step 1: Write a failing v3-to-v4 migration test**

Create a real v3 database fixture through the old schema SQL, insert rows with fixed IDs/external IDs, FTS content, and vector-map references, run `initializeSchema`, then assert all IDs/data remain and two rows may temporarily share a session/index while external IDs remain unique.

Run: `rtk pnpm exec vitest run tests/schema.test.ts tests/store.test.ts tests/connection.test.ts`  
Expected: FAIL at schema version/columns/constraint assertions.

- [ ] **Step 2: Implement schema v4 table-copy migration**

Set `CURRENT_SCHEMA_VERSION = 4`. In one transaction: load sqlite-vec when an existing vector table requires it; drop chunk FTS triggers/table; create `chunks_v4` with existing columns plus nullable `turn_key`, `source_order`, `observed_through`, `history_epoch`, `part_index`, `revision`, and `content_hash`; copy every v3 row preserving `id`; replace the table; restore `sqlite_sequence`; recreate project/created/session indexes, partial external-ID uniqueness, `idx_chunks_turn(session_id, turn_key, part_index)`, FTS table/triggers, and rebuild FTS.

Do not renumber IDs because `chunks_vec_map.chunk_id` references them.

Add migration tests for core mode with an old hybrid database both when sqlite-vec loads and when vector fallback is required. Inject failure after the table copy and assert transaction rollback leaves the v3 table, FTS, vector mapping, and schema version unchanged.

- [ ] **Step 3: Add cache fields and busy timeout**

Extend `Chunk` with optional v2 fields and execute:

```ts
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
```

- [ ] **Step 4: Verify and commit**

```bash
rtk pnpm exec vitest run tests/schema.test.ts tests/store.test.ts tests/connection.test.ts
rtk pnpm typecheck
rtk git add src/db tests/schema.test.ts tests/store.test.ts tests/connection.test.ts
rtk git commit -m "feat: migrate checkpoint cache to schema v4"
```

Expected: migration, FTS, and ID preservation tests pass.

---

### Task 8: Materialize revisions in SQLite

**Files:**

- Modify: `src/db/store.ts`
- Create: `tests/checkpoint/apply.test.ts`

**Interfaces:**

- Consumes: canonical `TurnCheckpointV2` and `CanonicalHistory`.
- Produces: idempotent latest-revision cache, contiguous derived indices, accurate sessions.

- [ ] **Step 1: Write failing revision application tests**

Cover inserted/already-current/stale/conflict, old observed boundary rejection, long-to-short revision removal, vector mapping cleanup for removed parts, contiguous reindexing, and session metadata recomputation.

- [ ] **Step 2: Implement exact Store APIs**

```ts
export interface StoredTurnState {
  revision: number;
  contentHash: string;
  observedThrough: ObservationBoundaryV2;
  historyEpoch: number;
}

export type ApplyCheckpointResult =
  | { status: 'inserted'; revision: number }
  | { status: 'already_current'; revision: number }
  | { status: 'stale'; revision: number }
  | { status: 'conflict'; revision: number };

// These are methods on the existing Store class (src/db/store.ts).
// The Store constructor receives the better-sqlite3 Database instance;
// the coordinator obtains a Store via EngramConfig.dbPath → openDatabase → new Store(db).
getStoredTurnState(sessionId: string, turnKey: string): StoredTurnState | undefined;
applyTurnCheckpoint(checkpoint: TurnCheckpointV2): ApplyCheckpointResult;
replaceSessionWithBaseline(sessionId: string, checkpoints: TurnCheckpointV2[]): void;
materializeCanonicalHistory(history: CanonicalHistory): {
  chunksInserted: number;
  sessionsInserted: number;
};
reindexSessionChunks(sessionId: string): void;
recomputeSessionMetadata(sessionId: string): void;
```

Each public mutator wraps its delete/insert/reindex/session update in one better-sqlite3 transaction. Sort v2 rows by `source_order`, `turn_key`, and `part_index`; retain legacy rows first in existing index order unless a reset supersedes them. Count only accepted canonical parts.

- [ ] **Step 3: Verify and commit**

```bash
rtk pnpm exec vitest run tests/checkpoint/apply.test.ts tests/store.test.ts
rtk pnpm typecheck
rtk git add src/db/store.ts tests/checkpoint/apply.test.ts tests/store.test.ts
rtk git commit -m "feat: materialize checkpoint revisions"
```

Expected: all tests pass.

---

### Task 9: Coordinate revision allocation and crash recovery

**Files:**

- Create: `src/checkpoint/coordinator.ts`
- Create: `src/checkpoint/service.ts`
- Create: `src/checkpoint/adapter.ts`
- Create: `tests/checkpoint/coordinator.test.ts`
- Create: `tests/checkpoint/recovery.test.ts`

**Interfaces:**

- Consumes: runtime candidates, pending keys, optional cursor, JSONL transaction writer, Store.
- Produces: revisioned committed checkpoints and resumable prepared receipts.

- [ ] **Step 1: Write failing crash-point and race tests**

Inject failures before JSONL, after JSONL/before phase update, after JSONL/before SQLite, after SQLite/before cursor, and after cursor/before pending removal. For the "after JSONL/before phase update" case, assert that `findCommitted` returns `true` for the existing committed transaction in the JSONL file and that recovery does not double-append (the receipt says `prepared` but the JSONL already has the committed transaction; verify by offset/line-count comparison). Race two changed candidates for one turn and an older Stop against a newer SessionEnd. Include a previous-month head, a prepared-but-uncommitted earlier observation, and a multi-turn legacy baseline batch. Assert revision allocation occurs under one writer transaction, older prepared work is completed or superseded before new allocation, and an older observation becomes stale.

- [ ] **Step 2: Define adapter and service contracts**

```ts
export interface AdapterExtraction {
  status: 'ready' | 'deferred';
  candidates: TurnCheckpointCandidate[];
  finalization: {
    pendingPaths: string[];
    cursorPath?: string;
    cursorAfter?: RuntimeCursorV2;
  };
  diagnostic?: string;
}

export interface AdapterEnvironment {
  config: EngramConfig;
  stateRoot: string;
  now(): Date;
  getOrCreateTurnSequence(runtime: HookRuntime, sessionId: string, pendingKey: string): number;
  allocateTurnSequenceRange(runtime: HookRuntime, sessionId: string, count: number): number[];
  reserveObservationSequence(runtime: HookRuntime, sessionId: string): number;
  log(message: string): void;
}

export interface RuntimeAdapter<TPrompt, TStop, TEnd> {
  parsePrompt(raw: string): TPrompt | null;
  parseStop(raw: string): TStop | null;
  parseSessionEnd(raw: string): TEnd | null;
  capturePrompt(payload: TPrompt, env: AdapterEnvironment): Promise<PendingPromptV2 | null>;
  extractStop(payload: TStop, env: AdapterEnvironment): Promise<AdapterExtraction>;
  extractSessionEnd(payload: TEnd, env: AdapterEnvironment): Promise<AdapterExtraction>;
}

export async function capturePendingPrompt(
  runtime: HookRuntime,
  raw: string,
  configPath?: string
): Promise<void>;
export async function checkpointStop(
  runtime: HookRuntime,
  raw: string,
  configPath?: string
): Promise<CheckpointCommitResult[]>;
export async function checkpointSessionEnd(
  runtime: HookRuntime,
  raw: string,
  configPath?: string
): Promise<CheckpointCommitResult[]>;

export interface CheckpointBatch {
  runtime: HookRuntime;
  sessionId: string;
  candidates: TurnCheckpointCandidate[];
  resetReason?: 'legacy_mismatch';
  finalization: AdapterExtraction['finalization'];
}

export async function commitCheckpointBatch(
  batch: CheckpointBatch,
  config: EngramConfig
): Promise<CheckpointCommitResult[]>;
export async function recoverPreparedCheckpoints(
  config: EngramConfig,
  runtime?: HookRuntime
): Promise<{ finalized: number; superseded: number; failed: number }>;
```

- [ ] **Step 3: Implement coordinator protocol**

`commitCheckpointBatch` calls `JsonlTransactionWriter.withExclusiveTransaction` once. Inside that synchronous callback it reconciles the all-file derived index, resumes or supersedes older prepared receipts touching the batch's turns, compares observation boundaries, allocates reset epoch and all revisions, serializes exact lines, durably writes the transaction-level receipt, appends it through the passed `LockedJsonlWriter`, and updates the derived index. It must not call another API that reacquires the writer lock. Resume older prepared receipts on the already-held `LockedJsonlWriter`, not by calling `recoverPreparedCheckpoints` (which acquires its own lock). Before calling `lockedWriter.appendPrepared(...)`, reconstruct a `SerializedJsonlTransaction` from the receipt's `{txId, targetPath, payloadDigest, allLines, records}` fields — the same reconstruction described for the post-crash recovery path. A prepared receipt is "still-valid" if its `observedThrough` boundary is not older than the current canonical head; stale prepared receipts are marked `superseded` before allocating a new revision for the same turn.

Adapter extraction is a two-phase process: (1) the adapter reads transcript/wire data and builds candidates without sequences (using provisional `sourceOrder`); (2) the coordinator acquires the writer lock, allocates turn sequences and observation sequences, finalizes `sourceOrder` (overwriting provisional values), and commits. `AdapterEnvironment.getOrCreateTurnSequence` and `reserveObservationSequence` are called during phase 2 inside the lock callback via closures that delegate to `LockedJsonlWriter` methods — they are not called from within async adapter extraction.

When a canonical head already exists for a `turnKey`, overwrite the candidate's provisional `sourceOrder` with the head's stored `sourceOrder` before hashing/serialization. Because `contentHash` does not include `sourceOrder` (per spec Section 4.3), this overwrite does not affect the hash. This keeps ordering stable after pending cleanup or index reconstruction.

The batch transaction ID is computed as: `hashFields(sessionId, [literal 'legacy_reset' if reset], historyEpoch.toString(), ...sortedTuples)` where `sortedTuples` is the lexically sorted list of `hashFields(turnKey, revision.toString(), contentHash)` for each candidate. If index reconciliation returns `cold` or `invalid`, no receipt is created and all results are deferred.

After the writer transaction commits, a normal batch applies every canonical checkpoint. A reset batch must instead call `replaceSessionWithBaseline` exactly once so v1 rows and all prior v2 rows (with lower `historyEpoch`) are replaced atomically; individual checkpoint apply is forbidden for that batch. Only after every result is `inserted`, `already_current`, or `stale` does the service write the batch cursor, remove the receipt's exact pending paths, fsync their directories, mark finalized, and delete the receipt. `recoverPreparedCheckpoints` owns the identical post-crash path and requires no adapter callback. It reconstructs a `SerializedJsonlTransaction` from the stored receipt's `txId`, `createdAt` (derived from the receipt's records), `targetPath`, `payloadDigest`, `allLines`, and `records` fields — these contain the exact same data as the original serialization.

For a superseded prepared receipt, recovery never writes its older cursor. The operation order is: (1) verify the canonical head proves the same `turnKey` has a committed checkpoint with an `observedThrough` boundary equal to or more recent than the superseded receipt's boundary; (2) durably mark the receipt as `superseded` via `updatePreparedPhase`; (3) only then remove the receipt's pending paths and fsync their directories; (4) remove the superseded receipt file. Step 2 must precede step 3 so that a crash between them leaves the receipt in `superseded` phase rather than losing both the pending file and the phase marker. If step 1 fails (canonical head does not cover the turn), leave the pending file for recovery.

At hook entry, the service reserves Codex observation sequence before parsing/extraction. Prompt capture computes `pendingKey`, atomically gets or creates its turn sequence, and stores both `turnSequence` and `sourceOrder` in `PendingPromptV2`; duplicate hook delivery reuses them. Legacy/recovery adapters reserve one contiguous range inside the writer transaction and assign it in source order.

Stop and SessionEnd checkpoint success never await embedding generation. New v2 parts remain eligible for the existing backfill command.

The coordinator requires these `EngramConfig` fields: `dbPath` (SQLite cache), `jsonlDir` (JSONL source of truth), `stateRoot` (base for `pending/`, `prepared/`, `cursors/` subdirectories). No new config fields are added; `stateRoot` defaults to the same directory as `dbPath`.

- [ ] **Step 4: Verify and commit**

```bash
rtk pnpm exec vitest run tests/checkpoint/coordinator.test.ts tests/checkpoint/recovery.test.ts
rtk pnpm typecheck
rtk git add src/checkpoint tests/checkpoint
rtk git commit -m "feat: coordinate resumable turn checkpoints"
```

Expected: every crash and race test passes without duplicate canonical turns.

---

### Task 10: Implement Claude raw transcript adapter and legacy cutover

**Files:**

- Modify: `src/parser/transcript.ts`
- Create: `src/checkpoint/adapters/claude.ts`
- Create: `tests/checkpoint/adapters/claude.test.ts`
- Create: `tests/checkpoint/legacy-cutover.test.ts`
- Modify: `src/hooks/recover.ts`
- Test: `tests/parser/transcript.test.ts`
- Test: `tests/hooks/recover.test.ts`

**Interfaces:**

- Consumes: Claude fixtures, pending prompts, coordinator.
- Produces: UUID/offset anchored logical turns and atomic legacy reset baselines.

- [ ] **Step 1: Write failing raw-record and adapter tests**

Test complete-line-only parsing, byte offsets, UUID fallback, compact exclusion, tool-result association, duplicate prompt capture, Stop continuation revision, last-message mismatch defer, SessionEnd residual, exact legacy prefix, and legacy mismatch baseline reset.

- [ ] **Step 2: Add raw transcript API while preserving `parseTranscript`**

```ts
export interface ClaudeTranscriptRecord {
  offset: number;
  endOffset: number;
  uuid?: string;
  parentUuid?: string;
  type?: string;
  sessionId: string;
  timestamp?: string;
  isCompactSummary: boolean;
  raw: unknown;
}

export async function readClaudeTranscriptRecords(
  filePath: string,
  fromOffset?: number
): Promise<{
  records: ClaudeTranscriptRecord[];
  completeByteLength: number;
  fileIdentity: string;
}>;
```

Make existing `parseTranscript` project normalized messages from this API so all old tests remain authoritative.

- [ ] **Step 3: Implement Claude adapter and cutover**

Export `claudeAdapter` with documented prompt/Stop/SessionEnd payload types. A logical turn begins at a user record and includes assistant/tool records through the current complete boundary. Repeated Stop uses the same user identity and a greater `observedThrough`.

For `last_assistant_message`, normalize CRLF to LF, trim trailing whitespace on each line and at the end, concatenate all assistant text blocks in the current logical turn (from the user record through the Stop boundary) in document order, and require exact equality. Do not include tool-use input or tool-result content in this comparison; those remain included in the checkpoint content/hash via the `toolResults` parameter of `createContentHash`. A mismatch returns deferred with no finalization.

For v1 sessions, flatten current source using `buildCheckpointParts`. Reserve one contiguous session turn-sequence range inside the writer transaction and assign it in transcript order because historical prompts have no pending sequence. Add a test asserting that contiguous range reservation during legacy baseline produces monotonically increasing `sourceOrder` values matching transcript order. Compare v1 chunk content using CRLF→LF normalization and trailing-whitespace trimming (per spec Section 10). If v1 chunks are an exact prefix ending at a turn boundary, persist only the suffix. Otherwise serialize one transaction containing `session_reset` plus every complete turn; replace SQLite only after that transaction commits.

Replace `recoverTranscripts` full-snapshot/random-ID saving with this adapter path. Replace the `store.hasSession()` skip condition with a `getTurnHead`-based check: if the coordinator's canonical index already has a checkpoint for the session's latest turn at an equal or newer observation boundary, skip that session. This avoids re-processing already-checkpointed sessions while still allowing incomplete sessions to be recovered.

- [ ] **Step 4: Verify and commit**

```bash
rtk pnpm exec vitest run tests/parser/transcript.test.ts tests/checkpoint/adapters/claude.test.ts tests/checkpoint/legacy-cutover.test.ts tests/hooks/recover.test.ts
rtk pnpm typecheck
rtk git add src/parser/transcript.ts src/checkpoint/adapters/claude.ts src/hooks/recover.ts tests
rtk git commit -m "feat: checkpoint Claude turns incrementally"
```

Expected: all Claude and legacy tests pass.

---

### Task 11: Migrate Codex to the common coordinator

**Files:**

- Create: `src/checkpoint/adapters/codex.ts`
- Modify: `src/hooks/codex.ts`
- Test: `tests/checkpoint/adapters/codex.test.ts`
- Test: `tests/hooks/codex.test.ts`

**Interfaces:**

- Consumes: Codex 0.141.0 fixtures.
- Produces: turn-ID-first candidates and anchored fallback behavior.

- [ ] **Step 1: Write failing adapter tests**

Cover turn ID present/absent, duplicate prompt hook, missing assistant, changed assistant revision, repeated same Stop, stale older delivery, and unknown payload.

- [ ] **Step 2: Implement payload parser and adapter**

Use these payload types:

```ts
export interface CodexPromptPayload {
  hook_event_name?: string;
  session_id: string;
  turn_id?: string;
  cwd?: string;
  prompt: string;
  model?: string;
}

export interface CodexStopPayload {
  hook_event_name?: string;
  session_id: string;
  turn_id?: string;
  cwd?: string;
  transcript_path?: string | null;
  last_assistant_message?: string | null;
  model?: string;
}
```

Prefer `turn_id` for identity. Prompt capture always reserves the session turn sequence used for `sourceOrder`. Every Stop reserves a separate observation delivery sequence immediately at service entry, before parsing; without `turn_id`, select only the exact unmatched pending anchor. Missing assistant returns deferred without cleanup.

Turn `src/hooks/codex.ts` into compatibility exports for existing imports; remove its custom JSONL/SQLite implementation.

- [ ] **Step 3: Verify and commit**

```bash
rtk pnpm exec vitest run tests/checkpoint/adapters/codex.test.ts tests/hooks/codex.test.ts
rtk pnpm typecheck
rtk git add src/checkpoint/adapters/codex.ts src/hooks/codex.ts tests
rtk git commit -m "refactor: use common checkpoints for Codex"
```

Expected: adapter and existing compatibility tests pass.

---

### Task 12: Add a schema-gated Kimi wire adapter

**Files:**

- Create: `src/checkpoint/adapters/kimi.ts`
- Modify: `src/hooks/kimi.ts`
- Test: `tests/checkpoint/adapters/kimi.test.ts`
- Test: `tests/hooks/kimi.test.ts`

**Interfaces:**

- Consumes: sanitized Kimi 0.18.0 wire fixtures.
- Produces: unambiguously complete candidates or deferred diagnostics with unchanged state.

- [ ] **Step 1: Write failing state-machine tests**

Cover string/parts prompt, explicit completion, multiple steps in one user turn, text/tool parts, partial line, unknown event, unknown completion schema, rotation replay, truncation, duplicate Stop, and SessionEnd.

- [ ] **Step 2: Implement Kimi cursor and state machine**

```ts
export interface KimiCursorV2 extends RuntimeCursorV2 {
  runtime: 'kimi';
  fileIdentity: string;
  sourceGeneration: number;
  completeOffset: number;
  currentUserEventId?: string;
  completedStepId?: string;
  fingerprint: string;
}

export type KimiWireEvent =
  | { kind: 'user'; offset: number; eventId: string; text: string }
  | { kind: 'step_begin'; offset: number; stepId: string; agent: 'main' }
  | { kind: 'text_part'; offset: number; stepId: string; text: string }
  | { kind: 'tool_result'; offset: number; stepId: string; content: string }
  | { kind: 'step_complete'; offset: number; stepId: string }
  | { kind: 'unknown'; offset: number; rawType?: string };

export interface KimiWireReadResult {
  status: 'ok' | 'rotated' | 'deferred';
  events: KimiWireEvent[];
  completeOffset: number;
  fileIdentity: string;
  diagnostic?: string;
}

export function readKimiWireEvents(wirePath: string, cursor?: KimiCursorV2): KimiWireReadResult;
export function extractKimiCompletedTurns(
  events: KimiWireEvent[],
  cursor?: KimiCursorV2
): AdapterExtraction;
```

Aggregate all recognized main-agent steps belonging to one user event. Emit only after the fixture-proven completion boundary. Ignore incomplete final lines. Accept rotation only when replay reproduces the stored prefix fingerprint. Unknown schema returns deferred and does not change cursor/pending.

If Task 1 proved no completion boundary, implement `extractStop` as a deterministic deferred diagnostic and implement only unambiguous SessionEnd extraction. Setup still installs the Kimi Stop hook; capability is determined by the production parser at runtime rather than by reading test documentation.

Turn `src/hooks/kimi.ts` into compatibility exports and remove all-prompts-plus-last-assistant behavior.

- [ ] **Step 3: Verify and commit**

```bash
rtk pnpm exec vitest run tests/checkpoint/adapters/kimi.test.ts tests/hooks/kimi.test.ts
rtk pnpm typecheck
rtk git add src/checkpoint/adapters/kimi.ts src/hooks/kimi.ts tests
rtk git commit -m "feat: checkpoint supported Kimi turns"
```

Expected: known fixtures pass; unknown/unsupported fixtures defer without state mutation.

---

### Task 13: Wire hooks, rebuild, and derived embeddings

**Files:**

- Modify: `src/hooks/recall.ts`
- Modify: `src/hooks/save.ts`
- Modify: `src/jsonl/rebuild.ts`
- Modify: `src/jsonl/converter.ts`
- Modify: `src/hooks/embed.ts`
- Modify: `src/cli.ts`
- Test: `tests/hooks/recall.test.ts`
- Test: `tests/hooks/save.test.ts`
- Test: `tests/jsonl/rebuild.test.ts`
- Test: `tests/jsonl/rebuild-vec0.test.ts`
- Test: `tests/hooks/embed.test.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**

- Consumes: runtime adapters, canonical fold, Store materialization.
- Produces: production dispatch and correct v1/v2 rebuild.

- [ ] **Step 1: Write failing dispatch and rebuild tests**

Assert `runRecall` awaits pending capture before search, `runSave` dispatches Stop versus SessionEnd by payload event, malformed input fails open, rebuild selects latest revisions/resets, counts canonical parts only, and missing v2 embedding still leaves FTS content searchable. Add a `fromMonth` regression proving older files still participate in canonical fold while only reported statistics are filtered. Add a SQLITE_BUSY injection test: after successful JSONL commit, inject a BUSY condition on the SQLite `applyTurnCheckpoint` call; assert the prepared receipt remains in `jsonl_committed` phase and is recoverable by `recoverPreparedCheckpoints`.

- [ ] **Step 2: Replace runtime persistence with service dispatch**

Keep `runSave(configPath?, runtime?)` as the CLI surface. Read stdin once, inspect `hook_event_name`, call `checkpointStop` or `checkpointSessionEnd`, log errors, and exit successfully. Remove Claude full-snapshot persistence and Kimi session aggregation from `save.ts`.

In `runRecall`, call `capturePendingPrompt(runtime, raw, configPath)` before `handleRecall`; remove asynchronous full-transcript recovery.

Update `src/jsonl/converter.ts`: remove the legacy full-session `insertChunks` snapshot writing function (now replaced by v2 checkpoint transactions) and update any v1→v2 import paths. If `converter.ts` still provides v1 record reading used by the fold, keep that path intact.

- [ ] **Step 3: Rebuild through canonical fold**

Make `rebuildFromJsonl` always fold every JSONL history file, fail on revision conflicts, truncate derived tables only after a successful fold, and call `materializeCanonicalHistory`. After successful SQLite materialization, call `rebuildCanonicalIndex(jsonlDir, files, stateRoots)`. That function obtains `BEGIN EXCLUSIVE` on the existing coordination database, preserves durable counters/pending-key mappings, and transactionally rebuilds only canonical/replay tables from the same fold plus pending/prepared state. It never replaces the SQLite file. A fold/materialization/index-build failure rolls back the index transaction and marks status rebuild-required. Add a child-process test where Stop attempts to reserve/commit during rebuild and prove it blocks, then continues with a strictly greater sequence and one canonical head. `fromMonth` filters reporting only and never limits canonical input. `chunksInserted` and session counts come only from materialized canonical parts. Preserve v1 inline embedding restore; v2 Stop never generates embeddings and missing vectors remain for explicit backfill.

- [ ] **Step 4: Verify and commit**

```bash
rtk pnpm exec vitest run tests/hooks/recall.test.ts tests/hooks/save.test.ts tests/jsonl/rebuild.test.ts tests/jsonl/rebuild-vec0.test.ts tests/hooks/embed.test.ts tests/cli.test.ts
rtk pnpm typecheck
rtk git add src/hooks src/jsonl src/cli.ts tests
rtk git commit -m "feat: wire incremental checkpoints into CLI"
```

Expected: all targeted tests pass.

---

### Task 14: Install and migrate owned lifecycle hooks safely

**Files:**

- Create: `src/hooks/ownership.ts`
- Modify: `src/hooks/setup.ts`
- Modify: `src/hooks/toml.ts`
- Create: `tests/hooks/ownership.test.ts`
- Modify: `tests/hooks/setup.test.ts`
- Modify: `tests/hooks/toml.test.ts`
- Create: `tests/fixtures/hooks/setup/*`

**Interfaces:**

- Consumes: existing JSON/TOML hook definitions and known historical local wrappers.
- Produces: exact managed hook sets and safe migration/uninstall classification.

- [ ] **Step 1: Write ownership fixtures and failing tests**

Positive fixtures: bare `kizami`, absolute binary, historical Node entrypoint, runtime present/absent, single/double quotes, and the known stdin-capturing background wrapper. Negative fixtures: `kizami search`, extra arguments, a pipe to another consumer, `my-kizami`, marker text inside a comment, and a command for another runtime.

- [ ] **Step 2: Implement strict classification**

```ts
export type HookOwnership = 'managed' | 'historical' | 'unrelated';

export function classifyJsonLifecycleCommand(
  command: string,
  event: string,
  runtime: HookRuntime
): HookOwnership;

export function isHistoricalLifecycleCommand(
  command: string,
  event: string,
  runtime: HookRuntime
): boolean;
```

Parse only the documented known wrappers; do not execute a shell or rely on `command.includes('kizami')`. JSON `managed` requires the command marker. JSON/TOML `historical` requires a recognized executable and an allowlisted `inject|recall|save --stdin` argument vector for the matching event/runtime. Kimi managed hooks are owned by the TOML BEGIN/END block and must not be classified from command text.

- [ ] **Step 3: Install the new hook sets**

Expected managed counts:

- Claude: SessionStart, UserPromptSubmit, Stop, SessionEnd = 4.
- Codex: SessionStart, UserPromptSubmit, Stop = 3.
- Kimi: SessionStart, UserPromptSubmit, Stop, SessionEnd = 4. Unknown live wire schemas defer safely inside the adapter.

Set Stop timeout to 10 seconds. Retain 5-second prompt hooks and stdin-capturing SessionEnd wrappers. Setup twice must be byte-stable modulo JSON formatting. Uninstall twice must remain successful and preserve unrelated hooks.

After storage initialization, setup calls `rebuildCanonicalIndex` when the derived writer index is absent or invalid. Status reports `checkpoint-index=ready|rebuild-required|corrupt`; `corrupt` indicates the writer-lock database failed to open and requires explicit offline backup/recreation with clear operator guidance. It never triggers an unbounded rebuild from a Stop hook.

- [ ] **Step 4: Verify and commit**

```bash
rtk pnpm exec vitest run tests/hooks/ownership.test.ts tests/hooks/setup.test.ts tests/hooks/toml.test.ts
rtk pnpm typecheck
rtk git add src/hooks/ownership.ts src/hooks/setup.ts src/hooks/toml.ts tests/hooks tests/fixtures/hooks/setup
rtk git commit -m "feat: migrate lifecycle hooks safely"
```

Expected: ownership, idempotency, counts, and preservation tests pass.

---

### Task 15: Integration, documentation, and quality gate

**Files:**

- Modify: `tests/integration.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: all earlier tasks.
- Produces: end-to-end proof and operator documentation.

- [ ] **Step 1: Add isolated end-to-end tests**

Using temporary HOME/XDG directories, test each supported runtime from prompt capture through Stop searchability, continued Stop convergence, SessionEnd convergence, rebuild equality, repeated setup/status/setup, and repeated uninstall/status. Never touch real user settings.

Add an integration case that kills an injected coordinator after JSONL commit, restarts, resumes prepared state, and verifies one canonical turn.

- [ ] **Step 2: Update documentation**

Document turn checkpoints, no external AI behavior, supported runtime/version boundaries, Kimi safe fallback, JSONL v2 transactions, schema-v4 migration, hook counts/timeouts, pending recovery, and rebuild semantics. State that embeddings may appear after FTS content.

- [ ] **Step 3: Run targeted tests repeatedly**

Concurrency tests must contain their own ten-case `it.each` repetition. Run:

```bash
rtk pnpm exec vitest run tests/checkpoint tests/jsonl/transaction-writer.test.ts tests/jsonl/concurrent-writer.test.ts tests/jsonl/fold.test.ts tests/checkpoint/adapters/claude.test.ts tests/checkpoint/adapters/codex.test.ts tests/checkpoint/adapters/kimi.test.ts tests/hooks/setup.test.ts tests/hooks/recall.test.ts tests/hooks/save.test.ts tests/hooks/ownership.test.ts tests/jsonl/rebuild.test.ts
```

Expected: all targeted tests pass with no intermittent failures.

- [ ] **Step 4: Run the full quality gate**

```bash
rtk pnpm install --frozen-lockfile
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm format
rtk pnpm secretlint
rtk pnpm build
rtk pnpm test
```

Expected: every command exits 0. Do not use `pnpm check` as the only evidence because individual command output is required for handoff.

- [ ] **Step 5: Commit**

```bash
rtk git add tests/integration.test.ts README.md CHANGELOG.md
rtk git commit -m "docs: document incremental turn checkpoints"
```

---

## Execution Dependencies

Execute strictly in this order:

```text
Task 1
  -> Task 2
  -> Task 3
  -> Task 4
  -> Task 5
  -> Task 6
  -> Task 7
  -> Task 8
  -> Task 9
  -> Tasks 10, 11, 12 (parallel after Task 9)
  -> Adapter integration gate
  -> Task 13
  -> Task 14
  -> Task 15
```

Only Tasks 10–12 are safe to parallelize. Keep ownership of shared files `types.ts`, `state.ts`, `coordinator.ts`, `save.ts`, `recall.ts`, `setup.ts`, `src/hooks/kimi.ts`, and `tests/hooks/kimi.test.ts` with one integrator. Task 12's changes to `kimi.ts` build on top of Task 3's earlier modifications (TTL removal), not on a fresh file.

Immediately after merging Tasks 10–12, before Task 13, run:

```bash
rtk pnpm typecheck
rtk pnpm exec vitest run tests/checkpoint/adapters/claude.test.ts tests/checkpoint/adapters/codex.test.ts tests/checkpoint/adapters/kimi.test.ts
```

Expected: typecheck and all three adapter suites pass together.

## Handoff Completion Checklist

- [ ] Every task has its own red-green-refactor test cycle and commit.
- [ ] Runtime fixtures contain no private conversation or credential material.
- [ ] Revision allocation occurs inside the JSONL writer lock.
- [ ] Older `observedThrough` values cannot overwrite a newer Stop/SessionEnd observation.
- [ ] Prepared receipts, not tail self-heal, provide v2 retry identity.
- [ ] Rebuild rejects revision conflicts rather than silently selecting one.
- [ ] Legacy mismatch reset and its baseline are one committed transaction.
- [ ] Kimi unsupported schema leaves state untouched and emits a diagnostic.
- [ ] Real user hook configuration is never used by tests.
- [ ] Full quality gate output is attached to the implementation handoff.
