# Compact Memory Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce token usage of memory injected into Claude Code by shortening the existing plaintext formatter output, without changing hook wiring, search behavior, storage schema, or JSONL canonical data.

**Architecture:** Keep `formatResults()` as the single formatting boundary used by both `kizami recall` and `kizami inject`. Replace verbose separators and labels with a compact plaintext format, and lower the per-result content cap from 500 characters to 360 characters. Add tests that compare output size against a legacy formatter fixture so the token-saving behavior is guarded by regression tests.

**Tech Stack:** TypeScript, Vitest, Node.js 24, existing `ScoredResult` type from `src/search/hybrid.ts`.

---

## Scope And Assumptions

- The hypothesis validation showed hook stdin is JSON, but LLM-injected stdout is plaintext from `src/search/formatter.ts`.
- This plan intentionally does not compress hook stdin JSON, because that data is not injected into the model context.
- This plan intentionally does not add new config, because the smallest useful change is a formatter-only output reduction.
- Existing `SessionStart` and `UserPromptSubmit` hooks keep using `formatResults()` unchanged at their call sites.
- Success criterion: formatter tests prove compact output is smaller than the current legacy output while preserving the important fields: memory header, date, short session ID, score, optional cross-project source tag, and content.

## File Structure

- Modify `src/search/formatter.ts`
  - Owns memory injection string rendering.
  - Reduce per-result content cap and remove high-overhead separator lines.
  - Preserve exported API: `formatResults(results: ScoredResult[], limit?: number): string`.

- Modify `tests/search/formatter.test.ts`
  - Update expectations for the compact format.
  - Add a local `legacyFormatResults()` fixture used only for size comparison.
  - Add regression tests for optional cross-project tags and output size reduction.

- Do not modify `src/hooks/inject.ts` or `src/hooks/recall.ts`
  - They should continue to call `formatResults()` exactly as they do today.

---

### Task 1: Add Failing Formatter Tests For Compact Output

**Files:**

- Modify: `tests/search/formatter.test.ts:17-92`
- Test: `tests/search/formatter.test.ts`

- [ ] **Step 1: Replace formatter tests with compact-format expectations**

Replace the whole `describe('formatResults', () => { ... })` block in `tests/search/formatter.test.ts` with:

```typescript
function legacyFormatResults(results: ScoredResult[], limit = 10): string {
  if (results.length === 0) return '';

  const capped = results.slice(0, limit);
  const header = '[Past Memory] 関連する過去の会話:\n';
  const entries = capped.map((r) => {
    const sessionShort = r.sessionId.slice(0, 6);
    const date = new Date(r.createdAt).toISOString().slice(0, 10);
    const score = r.score.toFixed(2);
    const content = r.content.length <= 500 ? r.content : r.content.slice(0, 500) + '...';

    return `---\n[${date} ${sessionShort}] (relevance: ${score})\n${content}\n---`;
  });

  return header + '\n' + entries.join('\n\n') + '\n';
}

describe('formatResults', () => {
  it('should return empty string for empty results', () => {
    expect(formatResults([])).toBe('');
  });

  it('should format a single result with compact metadata', () => {
    const results = [makeScoredResult()];
    const output = formatResults(results);

    expect(output).toContain('[Mem]');
    expect(output).toContain('2024-01-15');
    expect(output).toContain('abc123');
    expect(output).toContain('s=0.42');
    expect(output).toContain('React Hook Form');
    expect(output).not.toContain('関連する過去の会話');
    expect(output).not.toContain('relevance:');
  });

  it('should truncate content longer than 360 characters', () => {
    const longContent = 'x'.repeat(600);
    const results = [makeScoredResult({ content: longContent })];
    const output = formatResults(results);

    expect(output).toContain('x'.repeat(360) + '...');
    expect(output).not.toContain('x'.repeat(361));
  });

  it('should not truncate content at or under 360 characters', () => {
    const content = 'y'.repeat(360);
    const results = [makeScoredResult({ content })];
    const output = formatResults(results);

    expect(output).toContain(content);
    expect(output).not.toContain('...');
  });

  it('should use first 6 characters of session ID', () => {
    const results = [makeScoredResult({ sessionId: 'abcdef1234567890' })];
    const output = formatResults(results);

    expect(output).toContain('abcdef');
    expect(output).not.toContain('abcdef1234567890');
  });

  it('should respect limit parameter', () => {
    const results = [
      makeScoredResult({ id: 1, sessionId: 'abc111-session' }),
      makeScoredResult({ id: 2, sessionId: 'def222-session' }),
      makeScoredResult({ id: 3, sessionId: 'ghi333-session' }),
    ];

    const output = formatResults(results, 2);

    expect(output).toContain('abc111');
    expect(output).toContain('def222');
    expect(output).not.toContain('ghi333');
  });

  it('should separate multiple results with compact separators', () => {
    const results = [
      makeScoredResult({ id: 1, sessionId: 'session-aaa', score: 0.8 }),
      makeScoredResult({ id: 2, sessionId: 'session-bbb', score: 0.3 }),
    ];

    const output = formatResults(results);

    expect(output).toContain('[2024-01-15 sessio s=0.80]');
    expect(output).toContain('[2024-01-15 sessio s=0.30]');
    expect(output).toContain('\n---\n');
  });

  it('should include cross-project source tags compactly', () => {
    const results = [
      makeScoredResult({
        isLocalProject: false,
        projectPath: '/Users/example/work/other-project',
      }),
    ];

    const output = formatResults(results);

    expect(output).toContain(' from=other-project');
    expect(output).not.toContain('[from: other-project]');
  });

  it('should include date in YYYY-MM-DD format', () => {
    const results = [makeScoredResult({ createdAt: '2024-06-15T14:30:00.000Z' })];
    const output = formatResults(results);

    expect(output).toContain('2024-06-15');
  });

  it('should be smaller than the legacy formatter for max-length results', () => {
    const content = '[User]\n' + 'x'.repeat(700) + '\n\n[Assistant]\n' + 'y'.repeat(700);
    const results = [
      makeScoredResult({ id: 1, content, score: 0.8 }),
      makeScoredResult({ id: 2, content, sessionId: 'second-session', score: 0.6 }),
      makeScoredResult({ id: 3, content, sessionId: 'third-session', score: 0.4 }),
    ];

    const compact = formatResults(results, 3);
    const legacy = legacyFormatResults(results, 3);

    expect(compact.length).toBeLessThan(legacy.length);
    expect(compact.length).toBeLessThanOrEqual(Math.floor(legacy.length * 0.8));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk pnpm exec vitest run tests/search/formatter.test.ts
```

Expected: FAIL because current output still contains `[Past Memory]`, `relevance:`, 500-character truncation, and legacy separators.

---

### Task 2: Implement Compact Formatter Output

**Files:**

- Modify: `src/search/formatter.ts:4-44`
- Test: `tests/search/formatter.test.ts`

- [ ] **Step 1: Replace formatter implementation**

Replace `src/search/formatter.ts` with:

```typescript
import * as path from 'node:path';
import type { ScoredResult } from '@/search/hybrid';

const MAX_CONTENT_LENGTH = 360;
const DEFAULT_LIMIT = 10;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toISOString().slice(0, 10);
  } catch {
    return isoString;
  }
}

function extractProjectName(projectPath: string): string {
  return path.basename(projectPath);
}

export function formatResults(results: ScoredResult[], limit?: number): string {
  if (results.length === 0) {
    return '';
  }

  const capped = results.slice(0, limit ?? DEFAULT_LIMIT);

  const entries = capped.map((r) => {
    const sessionShort = r.sessionId.slice(0, 6);
    const date = formatDate(r.createdAt);
    const score = r.score.toFixed(2);
    const content = truncate(r.content, MAX_CONTENT_LENGTH);
    const projectTag =
      r.isLocalProject === false ? ` from=${extractProjectName(r.projectPath)}` : '';

    return `[${date} ${sessionShort}${projectTag} s=${score}]\n${content}`;
  });

  return '[Mem]\n' + entries.join('\n---\n') + '\n';
}
```

- [ ] **Step 2: Run formatter tests**

Run:

```bash
rtk pnpm exec vitest run tests/search/formatter.test.ts
```

Expected: PASS.

---

### Task 3: Verify Hook Integration Did Not Regress

**Files:**

- Test: `tests/hooks/inject.test.ts`
- Test: `tests/hooks/recall.test.ts`
- Test: `tests/search/formatter.test.ts`

- [ ] **Step 1: Run formatter and hook tests together**

Run:

```bash
rtk pnpm exec vitest run tests/search/formatter.test.ts tests/hooks/inject.test.ts tests/hooks/recall.test.ts
```

Expected: PASS. This verifies both hook paths still receive non-empty formatted memory output when rows exist.

- [ ] **Step 2: Run typecheck**

Run:

```bash
rtk pnpm typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run full test suite**

Run:

```bash
rtk pnpm test
```

Expected: PASS.

---

### Task 4: Document The Changed Injection Format

**Files:**

- Modify: `README.md:805-835`
- Test: documentation only, then run format check

- [ ] **Step 1: Update README output example and token-saving wording**

Replace the existing memory injection output example under `### 記憶注入の出力例` with:

Use this exact fenced text block in `README.md`:

````text
```text
[Mem]
[2024-01-15 abc123 s=0.42]
[User] ReactのフォームでuseStateとReact Hook Formどちらがいい？
[Assistant] 小規模ならuseState、複雑バリデーションならRHF。本プロジェクトではRHFを採用。
```
````

Then replace this sentence:

```markdown
Kizamiは関連度スコアによるフィルタリングで必要な記憶だけを375トークン以内に収めて注入します。
```

with:

```markdown
Kizamiは関連度スコアによるフィルタリングと短い注入フォーマットにより、必要な記憶だけを小さく収めて注入します。
```

- [ ] **Step 2: Run format check**

Run:

```bash
rtk pnpm format
```

Expected: PASS. If Prettier reports README formatting differences, run `rtk pnpm format:fix`, inspect the diff, and rerun `rtk pnpm format`.

---

## Self-Review

**Spec coverage:** Covered the verified finding that injected model context is plaintext, not JSON. Covered token reduction through the actual injected surface, `formatResults()`. Covered both hook consumers by keeping call sites unchanged and testing `inject` and `recall`.

**Placeholder scan:** No placeholders, TODOs, TBDs, or vague tasks remain. Each code-changing step includes exact code or exact README replacement text.

**Type consistency:** The implementation preserves the exported `formatResults(results: ScoredResult[], limit?: number): string` signature. Test fixtures continue to use `ScoredResult`. No new config or schema type is introduced.

**Risk check:** Main behavior change is the visible memory injection prefix changing from `[Past Memory] 関連する過去の会話:` to `[Mem]`. This is intentional for token reduction. Content cap reduction from 500 to 360 characters may omit more detail, but recall count and search ranking are unchanged.
