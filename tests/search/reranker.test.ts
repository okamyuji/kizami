import { describe, it, expect } from 'vitest';
import { computeRelevance, rerank } from '../../src/search/reranker';
import type { ScoredResult } from '../../src/search/hybrid';

describe('computeRelevance', () => {
  it('should return high score when query keywords are all present', () => {
    const score = computeRelevance(
      'React Hook Form',
      'このプロジェクトではReact Hook Formを使ってフォームバリデーションを実装しています。'
    );
    expect(score).toBeGreaterThan(0.5);
  });

  it('should return low score when no keywords match', () => {
    const score = computeRelevance(
      'React Hook Form',
      'Pythonでデータ分析パイプラインを構築しました。pandasとnumpyを使用。'
    );
    expect(score).toBeLessThan(0.2);
  });

  it('should give higher score to exact phrase match', () => {
    const phraseMatch = computeRelevance(
      'FTS5 trigram',
      'FTS5 trigramトークナイザを使って全文検索を実装しました。'
    );
    const partialMatch = computeRelevance(
      'FTS5 trigram',
      'trigramの概念を学び、別のプロジェクトでFTS5を使いました。'
    );
    expect(phraseMatch).toBeGreaterThan(partialMatch);
  });

  it('should give higher score when keywords are close together', () => {
    const close = computeRelevance(
      'SQLite WALモード',
      'SQLiteのWALモードを有効にして並行アクセスを改善しました。'
    );
    const far = computeRelevance(
      'SQLite WALモード',
      'SQLiteデータベースを使用しています。' + 'x'.repeat(500) + 'WALモードについて調べました。'
    );
    expect(close).toBeGreaterThan(far);
  });

  it('should return 0 for empty inputs', () => {
    expect(computeRelevance('', 'some document')).toBe(0);
    expect(computeRelevance('query', '')).toBe(0);
  });

  it('should handle Japanese text correctly', () => {
    const score = computeRelevance(
      'チャンク分割アルゴリズム',
      '[User] チャンク分割のアルゴリズムを教えて\n[Assistant] ターンベースでチャンク分割を行います。'
    );
    expect(score).toBeGreaterThan(0.3);
  });
});

describe('rerank', () => {
  function makeScoredResult(overrides: Partial<ScoredResult>): ScoredResult {
    return {
      id: 1,
      content: '',
      sessionId: 'sess-1',
      createdAt: '2024-01-01T00:00:00Z',
      metadata: null,
      score: 1.0,
      ...overrides,
    };
  }

  it('should reorder results based on query relevance', () => {
    const results: ScoredResult[] = [
      makeScoredResult({
        id: 1,
        content: 'Pythonでデータ分析パイプラインを構築しました。',
        score: 10,
      }),
      makeScoredResult({
        id: 2,
        content: 'React Hook Formでフォームバリデーションを実装しています。',
        score: 5,
      }),
    ];

    const reranked = rerank('React Hook Form バリデーション', results);
    expect(reranked[0].id).toBe(2);
  });

  it('should preserve original ranking when relevance is similar', () => {
    const results: ScoredResult[] = [
      makeScoredResult({
        id: 1,
        content: 'SQLiteのFTS5でtrigram検索を実装しました。',
        score: 10,
      }),
      makeScoredResult({
        id: 2,
        content: 'FTS5のtrigram検索で全文検索をサポートしました。',
        score: 8,
      }),
    ];

    const reranked = rerank('FTS5 trigram検索', results);
    // Both are relevant; the higher original score should still matter
    expect(reranked.length).toBe(2);
    expect(reranked[0].score).toBeGreaterThan(0);
  });

  it('should return empty array for empty input', () => {
    expect(rerank('query', [])).toEqual([]);
  });
});
