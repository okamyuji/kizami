import type { ScoredResult } from '@/search/hybrid';

/**
 * クエリとドキュメントの関連度をスコアリングするリランカーです。
 * FTS5のBM25スコアはキーワード出現頻度のみを見ますが、
 * リランカーはクエリ全体との意味的な関連度を評価します。
 *
 * スコアリング要素:
 * 1. キーワードカバレッジ: クエリのキーワードがドキュメントに何割含まれているか
 * 2. キーワード密度: ドキュメント長に対するキーワード出現頻度
 * 3. 近接ボーナス: キーワード同士が近くに出現する場合のボーナス
 * 4. 完全フレーズボーナス: クエリの部分フレーズがそのまま出現する場合のボーナス
 */

const MIN_KEYWORD_LENGTH = 2;
const CJK_RANGE = /[\u3000-\u9fff\uf900-\ufaff]/;
const NGRAM_SIZE = 3;

/**
 * テキストをトークンに分割します。
 * CJK文字(日本語/中国語/韓国語)を含む長いトークンは
 * N-gramに分割して部分一致を可能にします。
 */
function tokenize(text: string): string[] {
  const rawTokens = text
    .split(/[\s、。,.!?;:()[\]{}「」『』・\n\r\t]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= MIN_KEYWORD_LENGTH);

  const result: string[] = [];
  for (const token of rawTokens) {
    result.push(token);
    // CJK文字を含む長いトークンはN-gramに分割
    if (token.length > NGRAM_SIZE && CJK_RANGE.test(token)) {
      for (let i = 0; i <= token.length - NGRAM_SIZE; i++) {
        result.push(token.substring(i, i + NGRAM_SIZE));
      }
    }
  }
  return result;
}

function uniqueTokens(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

/**
 * キーワードカバレッジを計算します。
 * クエリキーワードのうち、ドキュメントに含まれている割合を返します。
 */
function computeCoverage(queryKeywords: string[], docLower: string): number {
  if (queryKeywords.length === 0) return 0;
  let found = 0;
  for (const kw of queryKeywords) {
    if (docLower.includes(kw)) {
      found++;
    }
  }
  return found / queryKeywords.length;
}

/**
 * キーワード密度を計算します。
 * ドキュメント内のキーワード出現回数をドキュメント長で正規化します。
 */
function computeDensity(queryKeywords: string[], docLower: string): number {
  if (docLower.length === 0) return 0;
  let totalOccurrences = 0;
  for (const kw of queryKeywords) {
    let pos = 0;
    while (pos < docLower.length) {
      const idx = docLower.indexOf(kw, pos);
      if (idx === -1) break;
      totalOccurrences++;
      pos = idx + kw.length;
    }
  }
  // 1000文字あたりの出現数に正規化
  return (totalOccurrences / docLower.length) * 1000;
}

/**
 * キーワード近接スコアを計算します。
 * 異なるキーワード同士が近くに出現するほど高スコアになります。
 */
function computeProximity(queryKeywords: string[], docLower: string): number {
  if (queryKeywords.length < 2) return 0;

  // 各キーワードの最初の出現位置を取得
  const positions: number[] = [];
  for (const kw of queryKeywords) {
    const idx = docLower.indexOf(kw);
    if (idx !== -1) {
      positions.push(idx);
    }
  }

  if (positions.length < 2) return 0;

  positions.sort((a, b) => a - b);

  // 隣接する出現位置のペア間の距離の平均を計算
  let totalDistance = 0;
  for (let i = 1; i < positions.length; i++) {
    totalDistance += positions[i] - positions[i - 1];
  }
  const avgDistance = totalDistance / (positions.length - 1);

  // 距離が近いほど高スコア（100文字以内で最大、1000文字以上で0に近づく）
  return Math.max(0, 1 - avgDistance / 1000);
}

/**
 * クエリのサブフレーズがドキュメントに含まれている場合のボーナスを計算します。
 * 連続する2-3キーワードの組み合わせを部分フレーズとして検査します。
 */
function computePhraseBonus(queryTokens: string[], docLower: string): number {
  if (queryTokens.length < 2) return 0;

  let bonus = 0;
  // 2トークンの連続フレーズ
  for (let i = 0; i < queryTokens.length - 1; i++) {
    const phrase = queryTokens[i] + ' ' + queryTokens[i + 1];
    if (docLower.includes(phrase)) {
      bonus += 0.3;
    }
    // スペースなし連結も検査（日本語向け）
    const joined = queryTokens[i] + queryTokens[i + 1];
    if (docLower.includes(joined)) {
      bonus += 0.3;
    }
  }

  // 3トークンの連続フレーズ
  for (let i = 0; i < queryTokens.length - 2; i++) {
    const phrase = queryTokens[i] + ' ' + queryTokens[i + 1] + ' ' + queryTokens[i + 2];
    if (docLower.includes(phrase)) {
      bonus += 0.5;
    }
    const joined = queryTokens[i] + queryTokens[i + 1] + queryTokens[i + 2];
    if (docLower.includes(joined)) {
      bonus += 0.5;
    }
  }

  return Math.min(bonus, 2.0);
}

/**
 * クエリとドキュメントの関連度スコアを計算します。
 * 0から1の範囲の値を返します（1に近いほど関連度が高い）。
 */
export function computeRelevance(query: string, document: string): number {
  const queryTokens = tokenize(query);
  const queryKeywords = uniqueTokens(queryTokens);
  const docLower = document.toLowerCase();

  if (queryKeywords.length === 0 || docLower.length === 0) return 0;

  const coverage = computeCoverage(queryKeywords, docLower);
  const density = computeDensity(queryKeywords, docLower);
  const proximity = computeProximity(queryKeywords, docLower);
  const phraseBonus = computePhraseBonus(queryTokens, docLower);

  // 密度を0-1の範囲に正規化（10回/1000文字で飽和）
  const normalizedDensity = Math.min(density / 10, 1);

  // 加重平均
  const score = coverage * 0.4 + normalizedDensity * 0.2 + proximity * 0.15 + phraseBonus * 0.25;

  return Math.min(score, 1.0);
}

/**
 * 検索結果をクエリとの関連度でリランキングします。
 * FTS5のBM25スコアとリランカースコアを統合して最終スコアを算出します。
 */
export function rerank(query: string, results: ScoredResult[]): ScoredResult[] {
  if (results.length === 0) return [];

  // 元のスコアを0-1に正規化
  const maxOriginal = Math.max(...results.map((r) => r.score));
  const minOriginal = Math.min(...results.map((r) => r.score));
  const range = maxOriginal - minOriginal || 1;

  return results
    .map((r) => {
      const originalNormalized = (r.score - minOriginal) / range;
      const relevance = computeRelevance(query, r.content);

      // 元スコア40% + リランカースコア60%で統合
      const combinedScore = originalNormalized * 0.4 + relevance * 0.6;

      return { ...r, score: combinedScore };
    })
    .sort((a, b) => b.score - a.score);
}
