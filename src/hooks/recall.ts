import * as fs from 'node:fs';
import { loadConfig } from '../config';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';
import type { SearchResult } from '../db/store';
import { Store } from '../db/store';
import { searchFts } from '../search/fts';
import { rankResults, reciprocalRankFusion } from '../search/hybrid';
import { formatResults } from '../search/formatter';

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
    cwd: string;
  },
  configPath?: string
): Promise<string> {
  const config = loadConfig(configPath);
  const db = getDatabase(config.database.path);

  try {
    initializeSchema(db);
    const store = new Store(db);

    const projectPath = fs.realpathSync(input.cwd);
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

        // tiered/allProjectsでは全プロジェクト横断、scopedではローカルのみ
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

    // 段階的パラメータ緩和: 結果が目標数に満たない場合、パラメータを順次緩和
    let halfLifeDays = config.search.timeDecayHalfLifeDays;
    let crossPenalty = isTiered ? config.search.crossProjectPenalty : undefined;
    const minScore = config.hooks.minRelevanceScore;

    // currentProjectPathは常に渡す (allProjectsモードでもisLocalProject判定に使用)
    let ranked = rankResults(results, halfLifeDays, input.prompt, projectPath, crossPenalty);
    let filtered = ranked.filter((r) => r.score >= minScore);

    // Phase 1: crossProjectPenaltyを緩和 (tieredモードのみ)
    if (filtered.length < targetCount && isTiered && crossPenalty != null && crossPenalty < 1.0) {
      crossPenalty = Math.min(crossPenalty * 3, 1.0);
      ranked = rankResults(results, halfLifeDays, input.prompt, projectPath, crossPenalty);
      filtered = ranked.filter((r) => r.score >= minScore);
    }

    // Phase 2: 時間減衰を緩和 (半減期を3倍に延長)
    if (filtered.length < targetCount) {
      halfLifeDays = halfLifeDays * 3;
      ranked = rankResults(results, halfLifeDays, input.prompt, projectPath, crossPenalty);
      filtered = ranked.filter((r) => r.score >= minScore);
    }

    // Phase 3: minRelevanceScoreを緩和
    if (filtered.length < targetCount && minScore > 0) {
      filtered = ranked.filter((r) => r.score >= 0);
    }

    if (filtered.length === 0) return '';

    return formatResults(filtered, targetCount);
  } finally {
    db.close();
  }
}

export async function runRecall(configPath?: string): Promise<void> {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as {
      prompt: string;
      session_id: string;
      cwd: string;
    };
    const result = await handleRecall(input, configPath);
    if (result) {
      process.stdout.write(result);
    }
  } catch (err) {
    process.stderr.write(`engram recall error: ${String(err)}\n`);
    process.exit(0);
  }
}
