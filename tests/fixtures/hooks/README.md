# Runtime Hook Payload Fixtures

Sanitized, synthetic fixtures that freeze the runtime hook payload contracts used by the incremental turn checkpoint implementation.

All private conversation content, paths, account values, tokens, and identifiers have been replaced with deterministic test values. See the substitution table below.

## Substitution rules

| Original data                        | Replacement                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| User home directory                  | `/opt/kizami-fixtures`                                                                        |
| Real project paths                   | `/opt/kizami-fixtures/project-alpha` or `/opt/kizami-fixtures/project-beta`                   |
| Session / turn / record UUIDs        | `claude-sess-*`, `codex-sess-*`, `kimi-sess-*`, `turn-*`, `record-*`, `prompt-uuid-*`, `ue-*` |
| Prompt / response text               | Synthetic phrases such as "Explain the contract test."                                        |
| Model names                          | `claude-sonnet-4`, `gpt-5.5`, `kimi-k2`                                                       |
| Tool input / result content          | Synthetic values such as "Synthetic tool result."                                             |
| Credentials, bearer tokens, API keys | Omitted; fixtures contain no credential material                                              |

## Runtime coverage

### `claude/`

JSON hook payloads and transcript JSONL files.

| File                                  | Purpose                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `userprompt-prompt-uuid-present.json` | `UserPromptSubmit` with `prompt_uuid` present.                                 |
| `userprompt-prompt-uuid-absent.json`  | `UserPromptSubmit` without `prompt_uuid` (offset anchor fallback).             |
| `stop-continuation.json`              | `Stop` continuation hook (`stop_hook_active: true`).                           |
| `session-end.json`                    | `SessionEnd` hook payload.                                                     |
| `tool-use-result.jsonl`               | Transcript with `tool_use` and `tool_result` records.                          |
| `compact-boundary.jsonl`              | Transcript containing a compact summary record to be skipped.                  |
| `partial-final-line.jsonl`            | Transcript whose final line is intentionally incomplete (no trailing newline). |
| `stop-continuation.jsonl`             | Transcript with multiple assistant records across a continued turn.            |

### `codex-0.141.0/`

JSON payloads for Codex CLI 0.141.0.

| File                             | Purpose                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `turn-id-present.json`           | Stop payload with `turn_id` present.                     |
| `turn-id-absent.json`            | Stop payload without `turn_id`.                          |
| `changed-assistant-content.json` | Stop payload showing a changed `last_assistant_message`. |
| `missing-assistant.json`         | Stop payload with no `last_assistant_message`.           |
| `unknown-fields.json`            | Payload containing extra unknown fields.                 |

### `kimi-0.18.0/`

JSON hook payloads and wire-format `.jsonl` files for Kimi Code 0.18.x.

| File                              | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `prompt-string.json`              | `UserPromptSubmit` with a string `prompt`.                             |
| `prompt-array.json`               | `UserPromptSubmit` with an array `prompt`.                             |
| `session-end.json`                | `SessionEnd` hook payload.                                             |
| `user-event.jsonl`                | Wire file containing a user submission event with an event ID.         |
| `step-begin.jsonl`                | Wire file containing a `step.begin` boundary.                          |
| `text-parts.jsonl`                | Wire file with text `content.part` events.                             |
| `tool-parts.jsonl`                | Wire file with tool-result `content.part` events.                      |
| `explicit-completion.jsonl`       | Wire file containing the explicit `step.complete` completion boundary. |
| `multiple-steps.jsonl`            | Wire file spanning multiple steps.                                     |
| `partial-line.jsonl`              | Wire file whose final line is incomplete (no trailing newline).        |
| `unknown-event.jsonl`             | Wire file containing an unrecognized event type.                       |
| `unknown-completion-schema.jsonl` | Wire file with a completion event whose schema is not recognized.      |
| `truncation.jsonl`                | Wire file simulating a truncated record in the middle of the stream.   |
| `rotation-replay.jsonl`           | Wire file used to verify rotation replay cursor fingerprinting.        |

## Kimi Stop support status

**`kimiStopSupported: true`**

The `kimi-0.18.0/explicit-completion.jsonl` fixture contains an unambiguous explicit completion boundary (`step.complete`). This fixture documents the recognized completion event that enables Kimi Stop checkpointing for version 0.18.x.
