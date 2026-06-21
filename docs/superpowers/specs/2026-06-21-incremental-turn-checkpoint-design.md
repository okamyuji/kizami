# Incremental Turn Checkpoint Design

**Date:** 2026-06-21

## 1. Goal

Persist completed conversation turns during an active Claude Code, Codex, or Kimi Code session without waiting for session termination.

The checkpoint is created immediately after each completed assistant turn. This is a stronger durability guarantee than waiting for several minutes of user inactivity and avoids a resident daemon or delayed background processes.

The feature must not call an external AI service. Existing deterministic transcript parsing and rule-based chunking remain the only summarization mechanism.

## 2. Current behavior

- Claude Code saves the complete transcript from `SessionEnd` through `handleSave`.
- Claude's `UserPromptSubmit` also starts `recoverTranscripts` asynchronously. Recovery saves a transcript only when its session row is absent, so it can capture an active session once but does not provide reliable incremental checkpoints.
- Codex stores the user prompt at `UserPromptSubmit` and persists one Q&A chunk at every `Stop`.
- Kimi stores prompts at `UserPromptSubmit` and combines all pending prompts with the last assistant response at `SessionEnd`.
- Claude compact-summary transcript entries are intentionally excluded from saved chunks.
- JSONL is the append-only source of truth. SQLite is a rebuildable derived cache.

Codex already has the desired checkpoint frequency, but its implementation is runtime-specific. Claude and Kimi require turn-level capture.

## 3. Problem in the existing Claude save path

`handleSave` parses the complete transcript, assigns new random external IDs, appends every chunk to JSONL, and then replaces the session's SQLite chunks.

Calling this path more than once during a session is unsafe:

1. Each snapshot is appended to JSONL with different IDs.
2. The same `sessionId + chunkIndex` appears in several snapshots.
3. JSONL rebuild processes older records first and ignores later index collisions.
4. A rebuild can therefore restore the first incomplete snapshot instead of the final conversation.

Turn checkpointing must append only previously unsaved completed turns. It must not reuse the full-transcript snapshot path.

## 4. Selected approach

Use each runtime's `Stop` lifecycle event as the primary checkpoint trigger:

- `UserPromptSubmit`: record the user side of the pending turn.
- `Stop`: resolve the matching assistant response and append the completed turn.
- `SessionEnd`: flush only completed turns that have not already been checkpointed.

No idle timer, daemon, launch agent, or model API is introduced.

Claude's documented `Notification:idle_prompt` is not used as a correctness dependency because its delay is not configurable and there are reported delivery inconsistencies. Codex and Kimi do not provide a native user-idle lifecycle event.

## 5. Architecture

### 5.1 Normalized events

Runtime payloads are normalized into these application events:

```ts
interface PromptSubmittedEvent {
  runtime: 'claude' | 'codex' | 'kimi';
  sessionId: string;
  turnId?: string;
  cwd: string;
  prompt: string;
  transcriptPath?: string;
  model?: string;
}

interface TurnStoppedEvent {
  runtime: 'claude' | 'codex' | 'kimi';
  sessionId: string;
  turnId?: string;
  cwd: string;
  transcriptPath?: string;
  lastAssistantMessage?: string;
  model?: string;
}

interface SessionEndedEvent {
  runtime: 'claude' | 'codex' | 'kimi';
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
}
```

Parsing malformed or incomplete hook input returns without blocking the host CLI.

### 5.2 Pending turn state

Pending state remains under the Kizami data directory:

```text
pending/
  <runtime>/
    <safe-session-id>-<turn-key>.json
```

Each file contains the normalized prompt, runtime, session ID, optional turn ID, project path, optional transcript path and model, creation time, and a content-derived turn key.

Writes use a temporary file in the same directory followed by an atomic rename. File mode is `0600`. A malformed pending file is quarantined by renaming it with a `.invalid` suffix rather than silently deleting potentially recoverable user data.

When a runtime does not supply a stable turn ID, the turn key is a SHA-256 hash of runtime, session ID, normalized prompt, and prompt occurrence ordinal. The occurrence ordinal prevents identical prompts in one session from collapsing into one turn.

### 5.3 Runtime adapters

#### Claude Code

`UserPromptSubmit` supplies `session_id`, `cwd`, `prompt`, and `transcript_path`; it creates the pending turn.

`Stop` supplies the common transcript path and the last assistant message. The adapter parses the transcript and pairs pending prompts with completed assistant turns in transcript order. Only turns whose assistant response is complete at the time of `Stop` are emitted.

The transcript is read-only. Compact-summary records remain excluded. The existing chunk formatting and tool-output truncation rules remain unchanged.

`SessionEnd` invokes the same incremental extraction and then removes only pending entries proven to have been persisted.

#### Codex

The current prompt-plus-`last_assistant_message` flow is retained but moved behind the common checkpoint writer. Existing `turn_id` is the preferred turn key. The deterministic fallback key is used when `turn_id` is absent.

`Stop` remains the primary save event. No Codex transcript format is treated as a stable interface.

#### Kimi Code

`UserPromptSubmit` creates one pending turn per prompt.

`Stop` reads `wire.jsonl` as a read-only event stream and extracts the final text from the latest completed main-agent step. A per-session cursor records the consumed wire event offset and completed-step fingerprint. The oldest unmatched pending prompt is paired with the next unconsumed completed assistant step.

`SessionEnd` runs the same cursor-based extraction for remaining completed steps. Pending prompts without a completed assistant response remain recoverable and are not saved as fabricated Q&A pairs.

Kimi session files are never modified.

### 5.4 Common checkpoint writer

The common writer accepts a completed turn:

```ts
interface CompletedTurn {
  runtime: 'claude' | 'codex' | 'kimi';
  sessionId: string;
  turnKey: string;
  projectPath: string;
  prompt: string;
  assistant: string;
  model?: string;
  completedAt: string;
}
```

It performs the following sequence:

1. Acquire a per-session lock file using exclusive creation. The lock records PID, process start identity, and acquisition time. A contender may remove it only after proving the owner process no longer exists; age alone never breaks a live lock.
2. Recheck whether the deterministic external ID already exists.
3. Format `[User]` and `[Assistant]` content and apply existing metadata extraction.
4. Generate `externalId = SHA-256(runtime, sessionId, turnKey, prompt, assistant)` with a runtime prefix.
5. Select `chunkIndex = current maximum + 1` while holding the lock.
6. Generate an embedding when hybrid mode is enabled. Embedding failure remains non-fatal.
7. Append the chunk to JSONL and `fsync` it.
8. Insert the identical chunk into SQLite without replacing existing session chunks.
9. Insert or update session metadata with total persisted chunk count and first/last user messages.
10. Atomically update the runtime cursor, then remove the matching pending file.
11. Release the lock in `finally`.

Lock acquisition uses bounded retries with jitter. Failure leaves pending data untouched and exits successfully from the hook so the next lifecycle event can retry. A process crash leaves a verifiably orphaned lock that the next invocation can reclaim.

### 5.5 Crash consistency

JSONL remains authoritative. The following crash points are handled:

- Before JSONL append: no durable chunk exists; pending remains for retry.
- After JSONL append but before SQLite insert: retry detects the deterministic external ID in JSONL through preflight self-heal and restores SQLite.
- After SQLite insert but before pending cleanup: retry detects the external ID and removes the matching pending entry without appending again.
- During cursor write: atomic rename preserves either the previous or next complete cursor state.

The writer must never insert into SQLite before the JSONL append succeeds.

## 6. Hook configuration

Installed hooks become:

| Runtime | SessionStart | UserPromptSubmit        | Stop                   | SessionEnd                           |
| ------- | ------------ | ----------------------- | ---------------------- | ------------------------------------ |
| Claude  | inject       | recall + pending prompt | incremental checkpoint | residual flush                       |
| Codex   | inject       | recall + pending prompt | incremental checkpoint | not required by current Codex schema |
| Kimi    | inject       | recall + pending prompt | incremental checkpoint | residual flush                       |

Hook commands remain lightweight and fail-open. Heavy hybrid embedding work uses the existing background behavior where required by host timeout constraints.

Setup removes only obsolete Kizami lifecycle commands that can be identified as Kizami's historical `inject`, `recall`, or `save --stdin` commands. Unrelated user-defined commands, including other commands containing the word `kizami`, are preserved. Re-running setup produces exactly one managed Kizami hook for each required event.

Uninstall removes only managed hooks and historical lifecycle commands that match the same strict migration patterns.

## 7. Backward compatibility and migration

- Existing JSONL records are not rewritten.
- Existing SQLite databases are migrated only through additive schema changes if cursor persistence requires a table. File-based cursors are preferred to avoid a schema change.
- Existing search, list, delete, export, rebuild, and self-heal behavior remains compatible with newly appended chunks.
- Existing Claude sessions saved as full snapshots remain readable.
- Claude's asynchronous `recoverTranscripts` call is replaced by the same incremental recovery path. It no longer writes a full snapshot and then suppresses later recovery merely because a session row exists.
- The first incremental checkpoint for a previously snapshotted active Claude session compares normalized completed-turn content against the existing session chunks and emits only the unmatched suffix. If the existing chunks are not an exact prefix of the transcript turns, the checkpoint logs the ambiguity and leaves the transcript untouched for `SessionEnd` rather than risking duplication or omission.
- Old pending Codex and Kimi files are accepted through runtime-specific compatibility readers and rewritten to the normalized format only when touched.

## 8. Error handling and privacy

- Hook parsing, transcript reads, lock contention, and persistence failures are logged to the existing Kizami error log and do not block the host CLI.
- Raw prompts and assistant responses are stored with the same privacy model as current Kizami history. Pending files remain mode `0600`.
- No transcript, prompt, or tool output is sent to a new external service.
- Existing tool-output truncation applies before persistence.
- Missing or rotating transcript/wire files leave pending data intact for later recovery.
- Stale pending files are not deleted solely because of age. Cleanup requires either a persisted matching external ID or an explicit maintenance policy implemented separately.

## 9. Testing strategy

### 9.1 Common writer

- Saves one completed turn to JSONL and SQLite with the same external ID.
- Repeating the same completed turn produces no duplicate.
- Concurrent saves for one session receive distinct monotonic chunk indices.
- Different sessions do not block each other.
- JSONL failure leaves SQLite and pending state unchanged.
- SQLite failure after JSONL append is repaired by retry/self-heal.
- A crash before pending cleanup does not duplicate the chunk.

### 9.2 Claude

- Two consecutive `Stop` events append two turns without replacing the first.
- Identical user prompts in one session remain distinct turns.
- Tool results remain attached to the correct assistant turn.
- Compact summaries remain excluded.
- `Stop` followed by `SessionEnd` does not duplicate data.
- Rebuilding SQLite from JSONL after several checkpoints restores every final turn.

### 9.3 Codex

- Existing turn-ID flow remains compatible.
- Missing turn ID uses the deterministic fallback.
- Repeated and concurrent `Stop` events remain idempotent.
- Existing pending files are migrated without loss.

### 9.4 Kimi

- Multiple prompts pair with their corresponding completed wire steps in order.
- A checkpoint followed by `SessionEnd` saves only the residual turns.
- Interrupted or incomplete steps do not consume pending prompts.
- Cursor recovery after restart resumes from the correct wire position.
- Wire truncation or rotation is detected through file identity and fingerprint checks.

### 9.5 Setup and migration

- Setup installs the required hooks for all three runtimes.
- Repeated setup is idempotent.
- Strictly recognized historical Kizami hooks are removed.
- Unrelated hooks are preserved.
- Status reports the new expected hook counts.
- Uninstall removes only Kizami-owned hooks.

## 10. Acceptance criteria

1. A completed assistant turn is searchable before its host session ends.
2. No external AI or new runtime dependency is used.
3. Repeating or racing hook delivery does not create duplicate chunks.
4. JSONL rebuild after multiple checkpoints restores all completed turns with their final content.
5. `SessionEnd` remains a safe residual flush and does not duplicate earlier checkpoints.
6. Existing unrelated Claude, Codex, and Kimi hook configuration is preserved.
7. The full typecheck, lint, format, secret scan, build, and test suite pass.

## 11. External compatibility references

- Claude Code hooks: <https://code.claude.com/docs/en/hooks>
- Claude Code hook guide: <https://code.claude.com/docs/en/hooks-guide>
- Codex configuration and lifecycle hook controls: <https://github.com/openai/codex/blob/main/docs/config.md>
- Codex hook schema: <https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json>
- Kimi Code hooks: <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html>
- Kimi Code sessions: <https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html>
