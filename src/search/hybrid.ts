import type { SearchResult } from '../db/store';
import { rerank } from './reranker';

export interface ScoredResult extends SearchResult {
  score: number;
  isLocalProject?: boolean;
}

function normalizeScore(rank: number | undefined): number {
  if (rank === undefined || rank === null) {
    return 0.5;
  }
  // BM25 rank from FTS5 is negative (lower = better match).
  // Negate to get positive score: more negative rank = higher score.
  return -rank;
}

function applyTimeDecay(
  results: { id: number; score: number; createdAt: string }[],
  halfLifeDays: number = 30
): typeof results {
  const now = Date.now();
  const lambda = Math.LN2 / (halfLifeDays * 86400000);
  return results
    .map((r) => ({
      ...r,
      score: r.score * Math.exp(-lambda * (now - new Date(r.createdAt).getTime())),
    }))
    .sort((a, b) => b.score - a.score);
}

function getChunkIndex(metadata: string | null): number | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (typeof parsed.chunkIndex === 'number') {
      return parsed.chunkIndex;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function deduplicateBySession(results: ScoredResult[]): ScoredResult[] {
  // Group by session
  const sessionGroups = new Map<string, ScoredResult[]>();
  for (const r of results) {
    const group = sessionGroups.get(r.sessionId) ?? [];
    group.push(r);
    sessionGroups.set(r.sessionId, group);
  }

  const output: ScoredResult[] = [];

  for (const [, group] of sessionGroups) {
    if (group.length === 1) {
      output.push(group[0]);
      continue;
    }

    // Annotate with chunk index
    const items = group.map((r) => ({
      result: r,
      chunkIndex: getChunkIndex(r.metadata),
    }));

    // Sort by chunkIndex (nulls at the end)
    items.sort((a, b) => {
      if (a.chunkIndex === null && b.chunkIndex === null) return 0;
      if (a.chunkIndex === null) return 1;
      if (b.chunkIndex === null) return -1;
      return a.chunkIndex - b.chunkIndex;
    });

    // Find adjacent chunk clusters
    const clusters: ScoredResult[][] = [];
    let currentCluster: { result: ScoredResult; chunkIndex: number | null }[] = [];

    for (const item of items) {
      if (item.chunkIndex === null) {
        // No chunk index info, treat as standalone
        if (currentCluster.length > 0) {
          clusters.push(currentCluster.map((c) => c.result));
          currentCluster = [];
        }
        clusters.push([item.result]);
        continue;
      }

      if (currentCluster.length === 0) {
        currentCluster.push(item);
        continue;
      }

      const lastChunkIndex = currentCluster[currentCluster.length - 1].chunkIndex;
      if (lastChunkIndex !== null && item.chunkIndex - lastChunkIndex <= 1) {
        currentCluster.push(item);
      } else {
        clusters.push(currentCluster.map((c) => c.result));
        currentCluster = [item];
      }
    }
    if (currentCluster.length > 0) {
      clusters.push(currentCluster.map((c) => c.result));
    }

    // Keep highest-scoring chunk from each cluster
    for (const cluster of clusters) {
      const best = cluster.reduce((a, b) => (a.score >= b.score ? a : b));
      output.push(best);
    }
  }

  return output.sort((a, b) => b.score - a.score);
}

/**
 * Reciprocal Rank Fusion (RRF) でFTS結果とベクトル検索結果を統合します。
 * k=60は原論文(Cormack et al., 2009)で最も安定していると報告された値です。
 */
export function reciprocalRankFusion(
  ftsResults: SearchResult[],
  vecResults: SearchResult[],
  k: number = 60
): SearchResult[] {
  const scores = new Map<number, { result: SearchResult; score: number }>();

  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i];
    const existing = scores.get(r.id);
    const rrfScore = 1 / (i + 1 + k);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(r.id, { result: r, score: rrfScore });
    }
  }

  for (let i = 0; i < vecResults.length; i++) {
    const r = vecResults[i];
    const existing = scores.get(r.id);
    const rrfScore = 1 / (i + 1 + k);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(r.id, { result: r, score: rrfScore });
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.result, rank: -entry.score }));
}

export function rankResults(
  results: SearchResult[],
  halfLifeDays?: number,
  query?: string,
  currentProjectPath?: string,
  crossProjectPenalty?: number
): ScoredResult[] {
  if (results.length === 0) {
    return [];
  }

  // Step 1: Normalize FTS5 rank to positive score
  let scored: ScoredResult[] = results.map((r) => ({
    ...r,
    score: normalizeScore(r.rank),
  }));

  // Step 2: Apply time decay
  const decayed = applyTimeDecay(
    scored.map((r) => ({ id: r.id, score: r.score, createdAt: r.createdAt })),
    halfLifeDays
  );

  // Map decayed scores back
  const scoreMap = new Map(decayed.map((d) => [d.id, d.score]));
  scored = scored.map((r) => ({ ...r, score: scoreMap.get(r.id) ?? r.score }));

  // Step 3: Deduplicate by session adjacency
  const deduped = deduplicateBySession(scored);

  // Step 4: Rerank with query-document relevance scoring
  let ranked = query ? rerank(query, deduped) : deduped;

  // Step 5: Apply cross-project penalty (tiered mode)
  if (currentProjectPath != null && crossProjectPenalty != null) {
    ranked = ranked.map((r) => ({
      ...r,
      isLocalProject: r.projectPath === currentProjectPath,
      score: r.projectPath === currentProjectPath ? r.score : r.score * crossProjectPenalty,
    }));
    ranked.sort((a, b) => b.score - a.score);
  }

  return ranked;
}
