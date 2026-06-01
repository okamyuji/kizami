import { describe, it, expect } from 'vitest';
import { formatResults } from '../../src/search/formatter';
import type { ScoredResult } from '../../src/search/hybrid';

function makeScoredResult(overrides: Partial<ScoredResult> = {}): ScoredResult {
  return {
    id: 1,
    content: '[User] How do I use React Hook Form?\n[Assistant] Use the useForm hook.',
    sessionId: 'abc123def456',
    createdAt: '2024-01-15T10:30:00Z',
    metadata: null,
    score: 0.42,
    ...overrides,
  };
}

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

  it('should omit cross-project source tags when project path is missing', () => {
    const result = makeScoredResult({ isLocalProject: false });
    delete (result as Partial<ScoredResult>).projectPath;

    const output = formatResults([result]);

    expect(output).toContain('[2024-01-15 abc123 s=0.42]');
    expect(output).not.toContain('from=');
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
