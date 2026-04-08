import * as fs from 'node:fs';
import { loadConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import type { SearchResult } from '@/db/store';
import { Store } from '@/db/store';
import { searchFts } from '@/search/fts';
import { rankResults, applyProjectPenalty, reciprocalRankFusion } from '@/search/hybrid';
import { formatResults } from '@/search/formatter';
import { recoverTranscripts } from '@/hooks/recover';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function handleRecall(
  input: {
    prompt: string;
    session_id: string;
    cwd?: string;
  },
  configPath?: string,
  projectOverride?: string
): Promise<string> {
  const config = loadConfig(configPath);
  const db = getDatabase(config.database.path);

  try {
    initializeSchema(db);
    const store = new Store(db);

    const rawPath = projectOverride || input.cwd || process.cwd();
    const projectPath = fs.realpathSync(rawPath);
    const isTiered = config.search.projectScope === 'tiered';
    const allProjects = config.search.projectScope === false;
    const scopedOnly = config.search.projectScope === true;
    const limit = isTiered ? config.search.defaultLimit * 3 : config.search.defaultLimit;
    const targetCount = config.hooks.recallLimit;

    const ftsResults = searchFts(store, {
      query: input.prompt,
      projectPath,
      limit,
      allProjects,
      tiered: isTiered,
    });

    let results: SearchResult[] = ftsResults;

    // hybridモード: FTS + ベクトル検索をRRFで統合
    if (config.search.mode === 'hybrid' && store.hasVecTable()) {
      try {
        const { getEmbedding } = await import('../search/embedding');
        const queryPrefix = '検索クエリ: ';
        const queryEmbedding = await getEmbedding(queryPrefix + input.prompt, config);

        const vecResults = scopedOnly
          ? store.searchVec(queryEmbedding, projectPath, limit)
          : store.searchVecAll(queryEmbedding, limit);

        if (vecResults.length > 0) {
          results = reciprocalRankFusion(ftsResults, vecResults);
        }
      } catch {
        // ベクトル検索に失敗した場合はFTS結果をそのまま使用
      }
    }

    if (results.length === 0) return '';

    let halfLifeDays = config.search.timeDecayHalfLifeDays;
    let crossPenalty = isTiered ? config.search.crossProjectPenalty : undefined;
    const minScore = config.hooks.minRelevanceScore;

    // Step 1-4（正規化→時間減衰→重複除去→リランク）を1回実行し、ペナルティなしの結果を保持
    let prepenalty = rankResults(results, halfLifeDays, input.prompt, projectPath);
    // Step 5: ペナルティ適用
    let ranked = applyProjectPenalty(prepenalty, projectPath, crossPenalty);
    let filtered = ranked.filter((r) => r.score >= minScore);

    // minScore>0: ユーザーが品質閾値を明示的に設定している場合、
    // フォールバックカスケードを適用しない（低品質な注入を防止）
    // minScore=0（デフォルト）: 従来どおりフォールバックで件数を確保
    if (minScore === 0) {
      // Phase 1: crossProjectPenaltyを緩和 (tieredモードのみ)
      if (filtered.length < targetCount && isTiered && crossPenalty != null && crossPenalty < 1.0) {
        crossPenalty = Math.min(crossPenalty * 3, 1.0);
        ranked = applyProjectPenalty(prepenalty, projectPath, crossPenalty);
        filtered = ranked.filter((r) => r.score >= minScore);
      }

      // Phase 2: 時間減衰を緩和 (半減期を3倍に延長)
      if (filtered.length < targetCount) {
        halfLifeDays = halfLifeDays * 3;
        prepenalty = rankResults(results, halfLifeDays, input.prompt, projectPath);
        ranked = applyProjectPenalty(prepenalty, projectPath, crossPenalty);
        filtered = ranked.filter((r) => r.score >= minScore);
      }

      // Phase 3: minRelevanceScoreを緩和
      if (filtered.length < targetCount) {
        filtered = ranked.filter((r) => r.score >= 0);
      }
    }

    if (filtered.length === 0) return '';

    return formatResults(filtered, targetCount);
  } finally {
    db.close();
  }
}

export async function runRecall(configPath?: string, projectOverride?: string): Promise<void> {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as {
      prompt: string;
      session_id: string;
      cwd?: string;
    };

    // 非同期でリカバリを実行（結果を待たず、失敗しても無視）
    recoverTranscripts(configPath).catch(() => {});

    const result = await handleRecall(input, configPath, projectOverride);
    if (result) {
      process.stdout.write(result);
    }
  } catch (err) {
    process.stderr.write(`kizami recall error: ${String(err)}\n`);
    process.exit(0);
  }
}
