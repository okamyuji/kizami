import type { Store, SearchResult } from '../db/store';

export interface FtsSearchOptions {
  query: string;
  projectPath: string;
  limit?: number;
  allProjects?: boolean;
  tiered?: boolean;
}

const DEFAULT_LIMIT = 20;
const MIN_KEYWORD_LENGTH = 3;
const CJK_RANGE = /[\u3000-\u9fff\uf900-\ufaff]/;
const NGRAM_SIZE = 3;
const MAX_CJK_NGRAMS_PER_TOKEN = 8;

/**
 * FTS5 trigram の MATCH はクエリ文字列全体を部分文字列として検索します。
 * そのため長いプロンプトをそのまま渡すとヒットしません。
 * プロンプトをキーワードに分割し、各キーワードで個別に検索して結果を統合します。
 *
 * 日本語などCJKテキストはスペース区切りがないため、
 * 助詞・記号で分割した上でN-gramに展開してFTS5 trigramに適合させます。
 */
function extractKeywords(text: string): string[] {
  // 空白・句読点・日本語助詞で分割
  const tokens = text.split(
    /[\s、。,.!?;:()[\]{}「」『』・\n\r\t]+|(?<=[はがをにでとものかへもやばてり])(?=[^\s])/
  );
  const keywords: string[] = [];
  const seen = new Set<string>();

  const addKeyword = (kw: string): void => {
    const lower = kw.toLowerCase();
    if (lower.length >= MIN_KEYWORD_LENGTH && !seen.has(lower)) {
      seen.add(lower);
      keywords.push(kw);
    }
  };

  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed.length < MIN_KEYWORD_LENGTH) continue;

    if (trimmed.length > NGRAM_SIZE && CJK_RANGE.test(trimmed)) {
      // CJKを含む長いトークンはN-gramに分割してFTS5 trigramで検索可能にする
      const step = Math.max(
        1,
        Math.floor((trimmed.length - NGRAM_SIZE) / (MAX_CJK_NGRAMS_PER_TOKEN - 1))
      );
      for (let i = 0; i <= trimmed.length - NGRAM_SIZE; i += step) {
        addKeyword(trimmed.substring(i, i + NGRAM_SIZE));
      }
    } else {
      addKeyword(trimmed);
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
  const {
    query,
    projectPath,
    limit = DEFAULT_LIMIT,
    allProjects = false,
    tiered = false,
  } = options;

  if (query.length === 0) {
    return [];
  }

  // tieredモードではsearchAllで全プロジェクト横断検索し、
  // ランキングフェーズでprojectPathに基づくペナルティを適用する
  const useAll = allProjects || tiered;

  // 2文字以下のクエリはLIKE検索にフォールバック
  if (query.length < MIN_KEYWORD_LENGTH) {
    return useAll ? store.searchLikeAll(query, limit) : store.searchLike(query, projectPath, limit);
  }

  const keywords = extractKeywords(query);

  // キーワードがない場合（全て短すぎる場合）はLIKE検索
  if (keywords.length === 0) {
    return useAll ? store.searchLikeAll(query, limit) : store.searchLike(query, projectPath, limit);
  }

  // 各キーワードでFTS5検索し、結果を統合
  const allResults: SearchResult[] = [];
  for (const keyword of keywords) {
    try {
      const results = useAll
        ? store.searchFTSAll(keyword, limit)
        : store.searchFTS(keyword, projectPath, limit);
      allResults.push(...results);
    } catch {
      // FTS5 MATCH でエラーが出るクエリ(特殊文字など)はスキップ
    }
  }

  return deduplicateResults(allResults).slice(0, limit);
}
