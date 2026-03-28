import * as fs from 'node:fs';
import { loadConfig } from '../config';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';
import { Store } from '../db/store';
import { searchFts } from '../search/fts';
import { rankResults } from '../search/hybrid';
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

    const results = searchFts(store, {
      query: input.prompt,
      projectPath,
      limit: config.search.defaultLimit,
      allProjects: !config.search.projectScope,
    });

    if (results.length === 0) return '';

    const ranked = rankResults(results, config.search.timeDecayHalfLifeDays);

    // Filter by minimum relevance score
    const filtered = ranked.filter((r) => r.score >= config.hooks.minRelevanceScore);

    if (filtered.length === 0) return '';

    return formatResults(filtered, config.hooks.recallLimit);
  } finally {
    db.close();
  }
}

export async function runRecall(): Promise<void> {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as {
      prompt: string;
      session_id: string;
      cwd: string;
    };
    const result = await handleRecall(input);
    if (result) {
      process.stdout.write(result);
    }
  } catch (err) {
    process.stderr.write(`engram recall error: ${String(err)}\n`);
    process.exit(0);
  }
}
