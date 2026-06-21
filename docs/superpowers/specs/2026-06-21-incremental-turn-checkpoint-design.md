# Incremental Turn Checkpoint Design

**Date:** 2026-06-21  
**Status:** Approved direction, revised after multi-agent review

## 1. Goal

Make completed conversation content searchable during an active Claude Code, Codex, or Kimi Code session instead of waiting for session termination.

The application uses deterministic parsing and the existing rule-based 512-token chunking. It does not call an external AI service and does not add an LLM summarizer.

The primary trigger is each runtime's `Stop` event. Because a blocking Stop hook can cause the same turn to continue and emit Stop again, Stop checkpoints are revisioned snapshots of one logical turn rather than irreversible declarations that the turn is final. Later revisions converge the canonical state.

## 2. Current behavior and defects

- Claude `SessionEnd` parses and saves the complete transcript. `UserPromptSubmit` also starts `recoverTranscripts`, which may save one active full snapshot when no session row exists.
- Codex saves one prompt/assistant pair at each `Stop` by combining a pending prompt with `last_assistant_message`.
- Kimi accumulates pending prompts and combines all of them with only the last assistant response at `SessionEnd`.
- Claude compact-summary records are excluded. Long turns are split into multiple chunks.
- JSONL is the append-only source of truth; SQLite is a rebuildable cache.

Repeated Claude full-snapshot saves append new random IDs for the same `sessionId + chunkIndex`. Rebuild keeps the first conflicting index and can restore an incomplete snapshot. The current JSONL writer can also leave a partial final line after a short write or crash, and the current tail-only self-heal cannot guarantee recovery after a month boundary or many unrelated writes.

## 3. Selected strategy

### 3.1 Lifecycle

- `UserPromptSubmit`: capture a durable pending prompt and its source-file anchor.
- `Stop`: extract the logical turn through the current Stop, generate a revision, and commit its rule-based chunks.
- repeated `Stop` for the same turn: commit a higher revision only when normalized content changes.
- `SessionEnd`: run the same extraction and commit the last revision plus any completed residual turns.
- `SessionStart`: inject memories as today.

No timer, daemon, launch agent, or idle notification is required. A Stop checkpoint is normally searchable when the hook returns, which is earlier than a multi-minute idle threshold.

### 3.2 Compatibility boundary

- Claude hooks are supported using documented `session_id`, `transcript_path`, `cwd`, `stop_hook_active`, and Stop lifecycle semantics.
- Codex support is pinned to the locally verified hook payload contract for CLI 0.141.0. Sanitized fixtures record `session_id`, optional `turn_id`, `cwd`, `prompt`, and `last_assistant_message`. A payload is recognized when it contains `session_id` as a non-empty string; any payload missing `session_id` is treated as unknown and fails open without deleting pending data.
- Kimi support is pinned initially to Kimi Code 0.18.x and the recognized `wire.jsonl` schema. The wire file is read-only. Unknown event shapes, missing completion boundaries, rotation ambiguity, or unsupported versions fail open and defer to a future compatible event or `SessionEnd`; they never fabricate a prompt/assistant pair.

## 4. Canonical identity and source anchors

### 4.1 Pending prompt identity

A pending prompt stores:

```ts
interface PendingPromptV2 {
  version: 2;
  runtime: 'claude' | 'codex' | 'kimi';
  sessionId: string;
  runtimeTurnId?: string;
  projectPath: string;
  prompt: string;
  model?: string;
  source: {
    path?: string;
    fileIdentity?: string;
    byteLength?: number;
    promptRecordOffset?: number;
  };
  pendingKey: string;
  turnSequence: number;
  sourceOrder: string;
  createdAt: string;
}
```

`pendingKey` is:

- Codex: `codex + sessionId + turn_id` when `turn_id` exists.
- Claude: `claude + sessionId + prompt transcript record UUID`; fallback is the transcript file identity plus the byte offset of the matching user record.
- Kimi: `kimi + sessionId + wire user-event ID`; fallback is wire file identity plus the byte offset of the matching user event.

The prompt hook first resolves the corresponding source user record. If the host has not appended it yet, it records file identity and byte length as an anchor; Stop resolves the first matching user record at or after that anchor. Two concurrent duplicate hooks therefore resolve to the same source identity, while a deliberately repeated prompt in a later turn has a different record identity or offset.

Pending writes use a temporary file, `fsync` the file, rename in the same directory, and `fsync` the parent directory. Mode is `0600`. Malformed state is renamed to `.invalid` and retained.

### 4.2 Logical turn identity

`turnKey` depends only on stable source identity:

```text
SHA-256(runtime, sessionId, runtimeTurnId-or-sourceUserRecordIdentity)
```

`sourceUserRecordIdentity` is always the resolved runtime-native record identity — Claude transcript record UUID, Kimi wire user-event ID, or Codex `turn_id` — never the interim file-identity+offset anchor captured at `UserPromptSubmit` time. The anchor is a transient pointer used only to locate the matching source record at Stop time; once resolved, the source record identity replaces it for all downstream identity computation. If Stop cannot resolve the anchor to a source record identity, it defers without computing `turnKey`.

Assistant content is not part of `turnKey`. Repeated Stop events for a continued turn therefore update the same logical turn.

### 4.3 Revision identity

Normalized turn content is chunked with the existing `buildChunks` rules. Each revision contains all parts:

```ts
interface TurnCheckpointV2 {
  sessionId: string;
  runtime: 'claude' | 'codex' | 'kimi';
  turnKey: string;
  sourceOrder: string;
  observedThrough: ObservationBoundaryV2;
  historyEpoch: number;
  revision: number;
  contentHash: string;
  completedAt: string;
  projectPath: string;
  parts: Array<{
    partIndex: number;
    externalId: string;
    content: string;
    role: 'human' | 'assistant' | 'mixed';
    metadata: Chunk['metadata'];
    tokenCount: number;
  }>;
}
```

```ts
type ObservationBoundaryV2 =
  | { kind: 'source_offset'; generation: number; offset: number }
  | { kind: 'delivery_sequence'; sequence: number };
```

Part `externalId` is stable across revisions:

```text
<runtime>-SHA-256(sessionId, turnKey, partIndex)
```

`contentHash` covers normalized prompt, assistant content, tool results, and every generated part; it does not cover `sourceOrder`. If the latest canonical checkpoint has the same hash, delivery is a no-op. If content changes, revision increments and replaces all prior parts for that turn. Parts that disappear in a shorter revision are removed from the SQLite cache during apply. An equal revision with a different `contentHash` is a coordinator inconsistency; it is reported as a `conflict` error, the incoming checkpoint is rejected, the session is marked rebuild-required, and both records are preserved for diagnostic purposes.

`observedThrough` is compared only by its runtime-specific variant. Observations of different `kind` for the same `sessionId` are a hard error indicating session ID collision across runtimes; comparison must guard by matching `kind` before numeric comparison. Claude and Kimi compare rotation generation and final complete byte offset. Codex reserves an atomic per-session delivery sequence immediately when every Stop or SessionEnd invocation begins; `turn_id` is identity only. A checkpoint whose boundary is older than the canonical boundary is `stale`, even if extraction finishes later.

Every prompt capture performs an atomic get-or-create allocation keyed by `(runtime, sessionId, pendingKey)`. Duplicate hook delivery reuses the stored `turnSequence`; `sourceOrder` is that sequence encoded as 20 decimal digits and is stored in the pending file. Legacy/recovery imports reserve a contiguous sequence range in source order while holding the writer transaction.

## 5. JSONL v2 transaction protocol

### 5.1 Records

JSONL v1 remains readable. New writes use transaction-framed v2 records:

```ts
type JsonlV2Record =
  | { v: 2; type: 'tx_begin'; txId: string; createdAt: string }
  | {
      v: 2;
      type: 'session_reset';
      txId: string;
      sessionId: string;
      historyEpoch: number;
      reason: 'legacy_mismatch';
    }
  | ({ v: 2; type: 'turn_checkpoint'; txId: string } & TurnCheckpointV2)
  | {
      v: 2;
      type: 'tx_commit';
      txId: string;
      recordCount: number;
      payloadDigest: string;
      createdAt: string;
    };
```

A transaction is canonical only when `tx_begin` and `tx_commit` exist in one complete frame, `recordCount` matches, and the SHA-256 digest of the exact payload lines matches `payloadDigest`. If a new `tx_begin` appears before the active frame's commit, the reader reports and abandons the incomplete frame, then may accept a later complete retry with the same `txId`.

Normal Stop writes one `turn_checkpoint`. Legacy baseline migration writes `session_reset` followed by all completed turn checkpoints in the same transaction. A crash cannot make the reset visible without the complete baseline.

`txId` is a length-prefixed SHA-256 over session ID, optional `legacy_reset`, allocated history epoch, and the complete lexically sorted tuple list `(turnKey, revision, contentHash)`. This defines both single-turn and multi-turn transaction identity and prevents reuse across reset epochs.

A prepared receipt is "still-valid" if and only if its `observedThrough` boundary is not older than the current canonical head boundary for the same `turnKey`. A prepared receipt whose boundary is stale is durably marked `superseded` before any new revision is allocated for that turn, not after.

### 5.2 File serialization and partial-tail repair

Every process coordinates through `jsonlDir/.writer-lock.sqlite`, using `BEGIN IMMEDIATE`, a 5-second busy timeout, and bounded retry with jitter. This lock database is coordination state, not canonical history. It serializes writers even when different application database paths share one JSONL directory.

The same coordination database maintains derived canonical `turn_heads`/`session_epochs`, durable turn sequences keyed by pending key, durable observation sequences, and per-file replay state. `sourceOrder` is also stored in every canonical turn head and is reused by later revisions. Replay state includes file identity, size, offset, and a transaction hash chain. Kizami owns these files as append-only; replacement/truncation or an unexpected identity/stat transition marks the index rebuild-required, while unsupported in-place editing is rejected as outside the storage contract. Each lock acquisition reconciles at most 4 MiB or 10,000 new records before serving a head query; exceeding either limit defers the hook with a logged diagnostic identifying the unreconciled delta size and a suggestion to run explicit rebuild. Pending state and prepared receipts are preserved; the next Stop after a successful rebuild will reconcile normally. Perpetual deferral is self-healing through the rebuild command and through `SessionEnd`, which may use a higher reconciliation limit or accept longer processing time.

Setup and explicit rebuild use `BEGIN EXCLUSIVE` on the same coordination database and transactionally rebuild only canonical-head/replay tables in place. They never rename or replace an open SQLite main file. Durable sequence counters and pending-key mappings are preserved and raised to maxima found in JSONL, pending, prepared, and existing coordination rows. A corrupt coordination database is not replaced while hooks may be active; explicit maintenance reports that all clients must stop before backup/recreation.

The writer exposes one callback-style exclusive API. Canonical-head lookup, prepared recovery, observation comparison, revision/epoch allocation, durable prepared-receipt creation, append, and derived-index update all run inside the same `BEGIN IMMEDIATE`. Nested writer-lock acquisition is prohibited.

While holding the writer transaction:

1. Open the target host/month JSONL file.
2. If it does not end in `\n`, copy bytes after the final newline to a timestamped `.corrupt` sidecar, `fsync` the sidecar, truncate the source to the final newline, and `fsync` it.
3. Reconcile the derived canonical index and process older prepared transactions touching any of the same turns. Complete a still-valid prepared transaction (one whose `observedThrough` is not older than the canonical head) first; durably mark a prepared observation already superseded by the head as `superseded` without appending it.
4. Return `stale` for an older boundary, `already_current` for an equal content hash, `conflict` for an equal revision with a different content hash, or allocate `revision = current + 1`. Revision allocation never occurs before acquiring this lock.
5. Search the target file for an already committed matching `txId`; if found, return its receipt.
6. Append the whole framed transaction with a `writeAll` loop that handles short writes.
7. `fsync` the JSONL file. If the JSONL file was newly created during step 1, also `fsync` its parent directory.
8. Commit the writer-lock transaction.

All records of one transaction target the file selected from the persisted transaction `createdAt`. A retry after a month boundary uses the original target path.

### 5.3 Prepared transaction receipt

Before append, the common service durably writes:

```ts
interface PreparedCheckpointV2 {
  version: 2;
  phase: 'prepared' | 'jsonl_committed' | 'sqlite_applied' | 'finalized' | 'superseded';
  txId: string;
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
}
```

Retry checks the exact `targetPath + txId + payloadDigest` and appends the stored `allLines` bytes without reserialization. It never depends on the configurable tail self-heal window. Identical committed transactions are not appended again.

State transitions use file `fsync`, atomic rename, and parent-directory `fsync`. `updatePreparedPhase` uses the same atomic temp-write/fsync/rename pattern as the initial `writeDurableJson`. The common service owns finalization. It finalizes a batch only after every turn is `inserted`, `already_current`, or `stale`; it writes the batch cursor, removes exactly the receipt's pending paths, fsyncs their directories, and marks the receipt finalized. A superseded receipt never writes its older cursor and removes pending only after the canonical head proves that the same `turnKey` has a committed checkpoint with an `observedThrough` boundary equal to or more recent than the superseded receipt's boundary. Recovery can perform these steps from the receipt alone after a restart.

## 6. SQLite derived-cache model

The chunks schema is migrated to store nullable v2 fields:

- `turn_key TEXT`
- `source_order TEXT`
- `part_index INTEGER`
- `revision INTEGER`
- `content_hash TEXT`
- `observed_through TEXT`
- `history_epoch INTEGER`

V1 rows keep these fields null. V2 part identity is `external_id`; `session_id + chunk_index` remains a derived presentation/search order, not canonical identity. The migration rebuilds the `chunks` table without the old unique `session_id + chunk_index` constraint and retains unique non-null `external_id`.

Applying a checkpoint runs in one SQLite transaction:

1. Ignore a lower history epoch, an older comparable observation, an older revision, or an identical revision/hash.
2. Reject and log an equal revision with a different hash.
3. Delete prior parts for the same `sessionId + turnKey`.
4. Insert every part of the new revision.
5. Recompute contiguous `chunkIndex` values for the session by sorting legacy rows first by their existing index, then v2 turns by `sourceOrder + turnKey + partIndex`.
6. Recompute the session row from accepted chunks and turn metadata.

Connection setup configures WAL, foreign keys, and `busy_timeout = 5000`. SQLITE_BUSY retries are bounded and jittered. JSONL is committed before the SQLite transaction. A failed cache apply leaves prepared state for retry.

Embedding generation happens only after core JSONL and SQLite content are durable. Timeout or model failure leaves a searchable FTS chunk and missing vector data for the existing backfill command. Embeddings are derived cache data and do not determine checkpoint success.

## 7. Rebuild and targeted recovery

Rebuild performs two stages. Transactions have deterministic diagnostic order `(createdAt, filePath, beginOffset, txId)`, but canonical selection uses epoch, observation boundary, and revision instead of file iteration order:

1. Fold canonical JSONL state:
   - accept v1 records only when their session has no committed reset;
   - accept only committed, digest-valid v2 transactions;
   - choose the highest committed `historyEpoch` for every reset session and ignore checkpoints from lower epochs;
   - group remaining v2 checkpoints by `sessionId + turnKey`;
   - choose the highest revision; equal revision/hash duplicates are one record; equal revision/different hash is an error;
   - apply stable part IDs and remove obsolete parts from earlier revisions.
2. Materialize SQLite:
   - insert only accepted canonical parts;
   - assign deterministic contiguous chunk indices;
   - count only inserted canonical parts;
   - rebuild session metadata and available embeddings.

Checkpoint retry uses its prepared receipt and exact target file, while canonical-head lookup uses the reconciled all-file derived index. It does not depend on full rebuild or tail self-heal. Existing tail self-heal remains for v1 compatibility but is not part of the v2 crash-consistency guarantee.

## 8. Runtime adapters

### 8.1 Claude

The raw transcript reader retains record UUID, byte offset, and event type in addition to the existing normalized message. A logical turn starts at a user record and includes following assistant text/tool calls/tool results until the next user record or current Stop boundary.

At Stop, only complete JSONL lines are parsed. The current turn is eligible when the transcript contains its user record and at least one assistant text record. The consistency check normalizes CRLF to LF, trims trailing whitespace on each line and at the end, concatenates all assistant text blocks in the current logical turn (from the user record through the Stop boundary) in document order, and requires equality with normalized `last_assistant_message`. Tool-use input and tool-result content are not included in this comparison; they remain included in the checkpoint content and hash. Mismatch defers without state mutation. Repeated Stop after another hook continues Claude produces the same `turnKey`, a changed hash, and a higher revision.

`SessionEnd` reads to EOF and commits the latest revision. `recoverTranscripts` is changed to use the same canonical adapter; it no longer writes one random-ID full snapshot.

### 8.2 Codex

`turn_id` is the canonical source identity. Without `turn_id`, the pending prompt's anchor and prompt hash form a fallback key; Stop selects only the latest unmatched pending entry for that exact session and anchor. Every Stop reserves its delivery sequence before parsing or storage work, so a slow older invocation becomes stale. Sanitized 0.141.0 fixtures verify the observed sequential-delivery contract; if live concurrent delivery violates it, changed equal-turn observations are reported as conflict rather than ordered from assistant text.

Codex does not depend on transcript format. A changed `last_assistant_message` for the same turn creates a higher revision. Missing assistant content preserves pending state.

### 8.3 Kimi

The adapter is a versioned state machine over recognized main-agent wire events. Its cursor contains file identity, last complete byte offset, current user-event identity, and completed step identity. It ignores a partial final line.

Recognized 0.18.x events are captured as sanitized fixtures before implementation. The adapter must identify user submission, `step.begin`, text parts, tool-result parts, and an explicit step/turn completion boundary. If the fixture or live stream lacks an unambiguous completion boundary, Stop checkpointing for that version is disabled and a diagnostic is logged; `SessionEnd` may save only an unambiguously complete final turn.

Rotation is accepted only when a new file can be matched to the same session and its replayed event prefix reproduces the cursor fingerprint. The cursor fingerprint is SHA-256 of the ordered sequence of recognized event IDs from the beginning of the session through the cursor's last complete step identity; replay for verification reads at most 256 events or 1 MiB. Truncation or an unmatched file identity causes fail-open without advancing cursor or deleting pending data.

The runtime adapter returns candidates plus a declarative finalization payload. The common service advances cursor and pending state only after every checkpoint in the extracted batch returns `inserted`, `already_current`, or `stale`.

## 9. Hook commands and time budgets

| Runtime | Event            | Command behavior                                              | Timeout                                                              |
| ------- | ---------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| Claude  | UserPromptSubmit | foreground pending capture + recall                           | existing default                                                     |
| Claude  | Stop             | foreground core checkpoint; embedding deferred to backfill    | 10 seconds                                                           |
| Claude  | SessionEnd       | stdin-capturing detached residual flush                       | 30 seconds (existing wrapper; must accommodate bounded SQLite retry) |
| Codex   | UserPromptSubmit | foreground pending capture + recall                           | 5 seconds                                                            |
| Codex   | Stop             | foreground core checkpoint; embedding deferred to backfill    | 10 seconds                                                           |
| Kimi    | UserPromptSubmit | foreground pending capture + recall                           | 5 seconds                                                            |
| Kimi    | Stop             | foreground core checkpoint; unknown wire schema safely defers | 10 seconds                                                           |
| Kimi    | SessionEnd       | stdin-capturing detached residual flush                       | 30 seconds (existing wrapper; must accommodate bounded SQLite retry) |

The acceptance point is hook completion for core mode. In hybrid mode, FTS content must be searchable at hook completion; Stop does not await embedding generation and vector availability follows through backfill.

Setup always adds Stop hooks for all three runtimes. Unknown Kimi wire schemas return a safe deferred diagnostic. Re-running setup leaves exactly one managed Kizami lifecycle hook per required event.

Historical-hook migration uses an allowlist parser, not substring matching. JSON managed hooks use their command marker. Kimi TOML managed ownership comes from its BEGIN/END block and is separate from command classification. The historical classifier recognizes only unmarked commands whose executable resolves to `kizami`, an absolute `.../kizami`, or the historical package entrypoint and whose arguments are one of:

- `inject --stdin [--runtime <matching-runtime>]`
- `recall --stdin [--runtime <matching-runtime>]`
- `save --stdin [--runtime <matching-runtime>]`

It accepts the known stdin-capturing background wrapper and quoting variants. It does not remove commands with extra subcommands, search terms, pipes to another consumer, or unrelated executables. Fixtures cover every migrated local legacy command and negative lookalikes. Uninstall applies the same ownership rule.

## 10. Legacy cutover

For a session containing v1 snapshot chunks:

1. Parse the current source into completed turns and generate flat chunks with the same existing chunker.
2. Compare the v1 SQLite chunk `content` fields with the generated flat prefix after CRLF→LF normalization and trailing-whitespace trimming on each line and at the end; `tokenCount` and `metadata` are not compared. The comparison is per-chunk content equality, not byte-exact including all fields.
3. If it is an exact prefix ending at a turn boundary, record a cursor after that turn and append only later v2 turns.
4. If it differs, append one committed baseline transaction containing `session_reset` and every currently completed turn checkpoint.
5. Only after the baseline transaction is canonical, replace that session's SQLite rows with the baseline materialization.

Baseline cache application calls one `replaceSessionWithBaseline` SQLite transaction. It must not apply baseline turns individually because legacy rows must disappear atomically. `replaceSessionWithBaseline` deletes all existing rows for the session (both v1 and any v2 rows with a lower `historyEpoch`) and inserts only baseline parts, in one transaction.

The reset epoch must be allocated while holding the writer lock. `historyEpoch = current + 1` is assigned inside the same `BEGIN IMMEDIATE` that serializes all writes, so no concurrent v2 checkpoint with a lower epoch can be committed between the baseline JSONL append and the `replaceSessionWithBaseline` call. Rebuild ignores all v1 records whenever a committed reset exists and ignores v2 checkpoints below the highest committed reset epoch. No old JSONL data is rewritten or deleted.

Old Codex/Kimi pending files have compatibility readers. The 24-hour Kimi TTL is removed. Age alone never deletes pending data; successfully persisted identity, explicit user maintenance, or malformed-file quarantine is required. Pending data accumulation is bounded by the number of active sessions × turns-per-session; each `pendingKey` maps to one file, so growth tracks distinct unpersisted turns rather than elapsed time.

## 11. Failure behavior

- Hook errors are logged and fail open.
- Pending and prepared state remain mode `0600`.
- Missing, partial, rotated, or unknown transcript/wire input never advances a cursor.
- JSONL failure leaves SQLite unchanged.
- JSONL success plus SQLite failure is retried from the exact prepared receipt.
- Repeated delivery, concurrent Stop/SessionEnd, and Stop continuation converge by stable turn key and revision.
- Partial JSONL tails are quarantined before later appends, preventing a corrupt line from consuming a new valid record.
- SQLite writer contention uses a 5-second timeout and bounded retries; exhaustion leaves prepared state.
- No prompt, assistant output, or tool result is sent to a new external service.

## 12. Required tests

### JSONL and recovery

- short write loop writes the complete transaction;
- partial final line is quarantined and the next transaction remains readable;
- concurrent different-session writers serialize through the writer-lock database;
- a 100,000 JSONL-line fixture (approximately 33,000 turn checkpoints in v2 transactions) distributed across 1,000 sessions with up to 100 turns each, spanning the current host/month file plus 10 prior month files with 1,000 lines each, proves by instrumented byte counts that warm Stop reads only bounded delta from the current month file and never scans prior-month files; the 8-second budget includes JSONL append and SQLite apply but excludes embedding generation; a release benchmark on the designated macOS/Node 24 runner must complete below 8 seconds, leaving margin under the 10-second hook timeout;
- an absent/stale derived index is rebuilt by setup/rebuild, while Stop defers with a diagnostic;
- crash before commit makes the transaction invisible to rebuild;
- crash after JSONL commit and before receipt update is found by exact tx lookup;
- retry after month rollover uses the original target path;
- reset without committed baseline is ignored;
- duplicate equal revision/hash folds once; equal revision/different hash errors;
- rebuild counts only canonical inserted parts and produces correct session metadata.

### Chunk and revision semantics

- a turn over 512 tokens produces multiple stable part IDs;
- a longer revision adds parts and a shorter revision removes obsolete parts;
- repeated identical Stop is a no-op;
- continued Stop updates the same turn to a higher revision;
- concurrent Stop and SessionEnd converge to the highest valid revision;
- a slow older Codex invocation reserved before a newer invocation is rejected as stale;
- same text submitted in two later turns receives distinct source identities.

### Runtime adapters

- Claude partial last line, compact boundary, multiple assistant/tool records, duplicate hook delivery, and Stop continuation fixtures;
- Codex 0.141.0 payload fixtures with and without turn ID;
- Kimi 0.18.x recognized wire fixtures, partial lines, tool events, multiple steps, unknown schema, rotation, and truncation;
- unsupported Kimi schema leaves pending/cursor unchanged.

### Cache and migration

- SQLITE_BUSY retry after JSONL commit;
- missing embedding does not block FTS search;
- exact legacy prefix cutover appends only the suffix;
- legacy mismatch commits an atomic reset baseline;
- rebuild after both migration paths restores the final full conversation;
- old pending files older than 24 hours remain recoverable;
- setup migration removes only strict historical lifecycle commands and preserves lookalikes;
- setup/status/uninstall are idempotent for every runtime.

## 13. Acceptance criteria

1. In core mode, a supported runtime's Stop checkpoint is FTS-searchable when the hook returns and before session termination.
2. No external AI call or new model dependency is introduced.
3. Repeated or continued Stop delivery converges to one canonical logical turn with the latest revision.
4. Long turns retain existing multi-chunk behavior with stable per-part identity.
5. JSONL rebuild after checkpoints, crashes, revisions, and legacy reset restores canonical final content without silent loss.
6. Session metadata and rebuild statistics count only canonical accepted chunks.
7. Unknown or incomplete runtime source data fails open without cursor movement or pending deletion.
8. Existing unrelated user hooks are preserved.
9. Typecheck, lint, formatting, secret scan, build, and the full test suite pass.

## 14. References

- Claude Code hooks: <https://code.claude.com/docs/en/hooks>
- Claude Code hooks guide: <https://code.claude.com/docs/en/hooks-guide>
- Codex configuration: <https://github.com/openai/codex/blob/main/docs/config.md>
- Codex hook schema: <https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json>
- Kimi Code hooks: <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html>
- Kimi Code sessions: <https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html>
