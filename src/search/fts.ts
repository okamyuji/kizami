import type { Store, SearchResult } from '../db/store';

export interface FtsSearchOptions {
  query: string;
  projectPath: string;
  limit?: number;
  allProjects?: boolean;
}

const DEFAULT_LIMIT = 20;
const MIN_KEYWORD_LENGTH = 3;

/**
 * FTS5 trigram の MATCH はクエリ文字列全体を部分文字列として検索します。
 * そのため長いプロンプトをそのまま渡すとヒットしません。
 * プロンプトをキーワードに分割し、各キーワードで個別に検索して結果を統合します。
 */
function extractKeywords(text: string): string[] {
  // 空白・句読点で分割し、trigram検索に必要な3文字以上のトークンを抽出
  const tokens = text.split(/[\s、。,.!?;:()[\]{}「」『』・\n\r\t]+/);
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed.length >= MIN_KEYWORD_LENGTH && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      keywords.push(trimmed);
    }
  }

  return keywords;
}

function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<number>();
  const unique: SearchResult[] = [];
  for (const r of results) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      unique.push(r);
    }
  }
  return unique;
}

export function searchFts(store: Store, options: FtsSearchOptions): SearchResult[] {
  const { query, projectPath, limit = DEFAULT_LIMIT, allProjects = false } = options;

  if (query.length === 0) {
    return [];
  }

  // 2文字以下のクエリはLIKE検索にフォールバック
  if (query.length < MIN_KEYWORD_LENGTH) {
    return allProjects
      ? store.searchLikeAll(query, limit)
      : store.searchLike(query, projectPath, limit);
  }

  const keywords = extractKeywords(query);

  // キーワードがない場合（全て短すぎる場合）はLIKE検索
  if (keywords.length === 0) {
    return allProjects
      ? store.searchLikeAll(query, limit)
      : store.searchLike(query, projectPath, limit);
  }

  // 各キーワードでFTS5検索し、結果を統合
  const allResults: SearchResult[] = [];
  for (const keyword of keywords) {
    try {
      const results = allProjects
        ? store.searchFTSAll(keyword, limit)
        : store.searchFTS(keyword, projectPath, limit);
      allResults.push(...results);
    } catch {
      // FTS5 MATCH でエラーが出るクエリ(特殊文字など)はスキップ
    }
  }

  return deduplicateResults(allResults).slice(0, limit);
}
