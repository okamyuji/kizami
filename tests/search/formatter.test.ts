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

describe('formatResults', () => {
  it('should return empty string for empty results', () => {
    expect(formatResults([])).toBe('');
  });

  it('should format a single result correctly', () => {
    const results = [makeScoredResult()];
    const output = formatResults(results);

    expect(output).toContain('[Past Memory]');
    expect(output).toContain('関連する過去の会話');
    expect(output).toContain('2024-01-15');
    expect(output).toContain('abc123');
    expect(output).toContain('relevance: 0.42');
    expect(output).toContain('React Hook Form');
  });

  it('should truncate content longer than 500 characters', () => {
    const longContent = 'x'.repeat(600);
    const results = [makeScoredResult({ content: longContent })];
    const output = formatResults(results);

    expect(output).toContain('x'.repeat(500) + '...');
    expect(output).not.toContain('x'.repeat(501));
  });

  it('should not truncate content at or under 500 characters', () => {
    const content = 'y'.repeat(500);
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
      makeScoredResult({ id: 1, sessionId: 'session-aaa' }),
      makeScoredResult({ id: 2, sessionId: 'session-bbb' }),
      makeScoredResult({ id: 3, sessionId: 'session-ccc' }),
    ];

    const output = formatResults(results, 2);
    const separatorCount = (output.match(/^---$/gm) || []).length;
    // 2 results = 4 separator lines (opening + closing for each)
    expect(separatorCount).toBe(4);
  });

  it('should format multiple results with separators', () => {
    const results = [
      makeScoredResult({ id: 1, sessionId: 'session-aaa', score: 0.8 }),
      makeScoredResult({ id: 2, sessionId: 'session-bbb', score: 0.3 }),
    ];

    const output = formatResults(results);

    expect(output).toContain('sessio');
    expect(output).toContain('relevance: 0.80');
    expect(output).toContain('relevance: 0.30');
  });

  it('should include date in YYYY-MM-DD format', () => {
    const results = [makeScoredResult({ createdAt: '2024-06-15T14:30:00.000Z' })];
    const output = formatResults(results);

    expect(output).toContain('2024-06-15');
  });
});
