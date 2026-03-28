import * as fs from 'node:fs';
import { loadConfig } from '../config';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';
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
    const limit = config.search.defaultLimit;
    const allProjects = !config.search.projectScope;

    const ftsResults = searchFts(store, {
      query: input.prompt,
      projectPath,
      limit,
      allProjects,
    });

    let results = ftsResults;

    // hybridモード: FTS + ベクトル検索をRRFで統合
    if (config.search.mode === 'hybrid' && store.hasVecTable()) {
      try {
        const { getEmbedding } = await import('../search/embedding');
        const queryPrefix = '検索クエリ: ';
        const queryEmbedding = await getEmbedding(queryPrefix + input.prompt, config);

        const vecResults = allProjects
          ? store.searchVecAll(queryEmbedding, limit)
          : store.searchVec(queryEmbedding, projectPath, limit);

        if (vecResults.length > 0) {
          results = reciprocalRankFusion(ftsResults, vecResults);
        }
      } catch {
        // ベクトル検索に失敗した場合はFTS結果をそのまま使用
      }
    }

    if (results.length === 0) return '';

    const ranked = rankResults(results, config.search.timeDecayHalfLifeDays, input.prompt);
    const filtered = ranked.filter((r) => r.score >= config.hooks.minRelevanceScore);

    if (filtered.length === 0) return '';

    return formatResults(filtered, config.hooks.recallLimit);
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
