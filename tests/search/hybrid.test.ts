import { describe, it, expect } from 'vitest';
import type { SearchResult } from '../../src/db/store';
import { rankResults, applyProjectPenalty } from '../../src/search/hybrid';
import type { ScoredResult } from '../../src/search/hybrid';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 1,
    content: 'Test content',
    sessionId: 'session-1',
    projectPath: '/project/local',
    createdAt: new Date().toISOString(),
    metadata: null,
    rank: -5,
    ...overrides,
  };
}

describe('rankResults', () => {
  it('should return empty array for empty input', () => {
    expect(rankResults([])).toEqual([]);
  });

  it('should normalize negative FTS5 rank to positive score', () => {
    const results = [makeResult({ rank: -10 })];
    const scored = rankResults(results);

    expect(scored.length).toBe(1);
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('should assign default score when rank is undefined', () => {
    const results = [makeResult({ rank: undefined })];
    const scored = rankResults(results);

    expect(scored.length).toBe(1);
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('should give higher score to better FTS5 rank', () => {
    const now = new Date().toISOString();
    const results = [
      makeResult({ id: 1, rank: -10, createdAt: now }),
      makeResult({ id: 2, rank: -2, sessionId: 'session-2', createdAt: now }),
    ];

    const scored = rankResults(results);

    // rank -10 is a better match than -2 (more negative = better)
    const score1 = scored.find((s) => s.id === 1)!.score;
    const score2 = scored.find((s) => s.id === 2)!.score;
    expect(score1).toBeGreaterThan(score2);
  });

  describe('time decay', () => {
    it('should reduce score for older results', () => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

      const results = [
        makeResult({ id: 1, rank: -10, createdAt: now.toISOString() }),
        makeResult({
          id: 2,
          rank: -10,
          sessionId: 'session-2',
          createdAt: thirtyDaysAgo.toISOString(),
        }),
      ];

      const scored = rankResults(results);

      const recentScore = scored.find((s) => s.id === 1)!.score;
      const oldScore = scored.find((s) => s.id === 2)!.score;
      expect(recentScore).toBeGreaterThan(oldScore);
    });

    it('should respect custom half-life', () => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

      const results = [
        makeResult({ id: 1, rank: -10, createdAt: now.toISOString() }),
        makeResult({
          id: 2,
          rank: -10,
          sessionId: 'session-2',
          createdAt: sevenDaysAgo.toISOString(),
        }),
      ];

      // With 7-day half-life, the 7-day old result should be about half
      const scored = rankResults(results, 7);
      const recentScore = scored.find((s) => s.id === 1)!.score;
      const oldScore = scored.find((s) => s.id === 2)!.score;

      const ratio = oldScore / recentScore;
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(0.6);
    });
  });

  describe('deduplication', () => {
    it('should keep highest-scoring chunk from same session with adjacent indices', () => {
      const now = new Date().toISOString();
      const results = [
        makeResult({
          id: 1,
          sessionId: 'session-1',
          rank: -10,
          createdAt: now,
          metadata: JSON.stringify({ chunkIndex: 0 }),
        }),
        makeResult({
          id: 2,
          sessionId: 'session-1',
          rank: -5,
          createdAt: now,
          metadata: JSON.stringify({ chunkIndex: 1 }),
        }),
        makeResult({
          id: 3,
          sessionId: 'session-1',
          rank: -8,
          createdAt: now,
          metadata: JSON.stringify({ chunkIndex: 2 }),
        }),
      ];

      const scored = rankResults(results);

      // All three are adjacent in same session, so only the best should remain
      expect(scored.length).toBe(1);
      expect(scored[0].id).toBe(1); // rank -10 is the best match
    });

    it('should keep results from different sessions separate', () => {
      const now = new Date().toISOString();
      const results = [
        makeResult({
          id: 1,
          sessionId: 'session-1',
          rank: -10,
          createdAt: now,
        }),
        makeResult({
          id: 2,
          sessionId: 'session-2',
          rank: -10,
          createdAt: now,
        }),
      ];

      const scored = rankResults(results);
      expect(scored.length).toBe(2);
    });

    it('should keep non-adjacent chunks from same session', () => {
      const now = new Date().toISOString();
      const results = [
        makeResult({
          id: 1,
          sessionId: 'session-1',
          rank: -10,
          createdAt: now,
          metadata: JSON.stringify({ chunkIndex: 0 }),
        }),
        makeResult({
          id: 2,
          sessionId: 'session-1',
          rank: -8,
          createdAt: now,
          metadata: JSON.stringify({ chunkIndex: 5 }),
        }),
      ];

      const scored = rankResults(results);

      // Chunks 0 and 5 are not adjacent, so both should remain
      expect(scored.length).toBe(2);
    });
  });

  it('should sort final results by score descending', () => {
    const now = new Date().toISOString();
    const results = [
      makeResult({ id: 1, sessionId: 'session-1', rank: -2, createdAt: now }),
      makeResult({ id: 2, sessionId: 'session-2', rank: -10, createdAt: now }),
      makeResult({ id: 3, sessionId: 'session-3', rank: -5, createdAt: now }),
    ];

    const scored = rankResults(results);
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
    }
  });

  describe('cross-project penalty', () => {
    it('should apply penalty to non-local results', () => {
      const now = new Date().toISOString();
      const results = [
        makeResult({
          id: 1,
          sessionId: 'session-1',
          rank: -10,
          createdAt: now,
          projectPath: '/local',
        }),
        makeResult({
          id: 2,
          sessionId: 'session-2',
          rank: -10,
          createdAt: now,
          projectPath: '/remote',
        }),
      ];

      const scored = rankResults(results, 30, undefined, '/local', 0.3);
      const local = scored.find((s) => s.id === 1)!;
      const remote = scored.find((s) => s.id === 2)!;

      expect(local.isLocalProject).toBe(true);
      expect(remote.isLocalProject).toBe(false);
      expect(local.score).toBeGreaterThan(remote.score);
    });

    it('should set isLocalProject without penalty when crossProjectPenalty is undefined', () => {
      const now = new Date().toISOString();
      const results = [
        makeResult({
          id: 1,
          sessionId: 'session-1',
          rank: -10,
          createdAt: now,
          projectPath: '/local',
        }),
        makeResult({
          id: 2,
          sessionId: 'session-2',
          rank: -10,
          createdAt: now,
          projectPath: '/remote',
        }),
      ];

      const scored = rankResults(results, 30, undefined, '/local');
      const local = scored.find((s) => s.id === 1)!;
      const remote = scored.find((s) => s.id === 2)!;

      expect(local.isLocalProject).toBe(true);
      expect(remote.isLocalProject).toBe(false);
      // Scores should be equal (no penalty)
      expect(Math.abs(local.score - remote.score)).toBeLessThan(0.001);
    });
  });
});

describe('applyProjectPenalty', () => {
  function makeScoredResult(overrides: Partial<ScoredResult> = {}): ScoredResult {
    return {
      id: 1,
      content: 'Test',
      sessionId: 'session-1',
      projectPath: '/project/local',
      createdAt: new Date().toISOString(),
      metadata: null,
      score: 1.0,
      ...overrides,
    };
  }

  it('should return results unchanged when currentProjectPath is null', () => {
    const results = [makeScoredResult({ score: 0.8 })];
    const penalized = applyProjectPenalty(results);
    expect(penalized[0].score).toBe(0.8);
    expect(penalized[0].isLocalProject).toBeUndefined();
  });

  it('should mark local and remote results correctly', () => {
    const results = [
      makeScoredResult({ id: 1, projectPath: '/local', score: 0.8 }),
      makeScoredResult({ id: 2, projectPath: '/remote', score: 0.8 }),
    ];
    const penalized = applyProjectPenalty(results, '/local', 0.3);
    const local = penalized.find((r) => r.id === 1)!;
    const remote = penalized.find((r) => r.id === 2)!;

    expect(local.isLocalProject).toBe(true);
    expect(local.score).toBe(0.8);
    expect(remote.isLocalProject).toBe(false);
    expect(remote.score).toBeCloseTo(0.24);
  });

  it('should sort by score after penalty', () => {
    const results = [
      makeScoredResult({ id: 1, projectPath: '/remote', score: 0.9 }),
      makeScoredResult({ id: 2, projectPath: '/local', score: 0.5 }),
    ];
    const penalized = applyProjectPenalty(results, '/local', 0.3);

    expect(penalized[0].id).toBe(2); // local 0.5 > remote 0.9*0.3=0.27
    expect(penalized[1].id).toBe(1);
  });

  it('should not mutate the original array', () => {
    const results = [makeScoredResult({ id: 1, projectPath: '/remote', score: 0.8 })];
    const penalized = applyProjectPenalty(results, '/local', 0.3);

    expect(results[0].score).toBe(0.8); // original unchanged
    expect(penalized[0].score).toBeCloseTo(0.24);
  });
});
