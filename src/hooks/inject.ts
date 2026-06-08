import * as fs from 'node:fs';
import { loadConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { formatResults } from '@/search/formatter';
import type { SearchResult } from '@/db/store';
import type { HookRuntime } from '@/hooks/recall';
import { parseKimiSessionStartInput } from '@/hooks/kimi';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * SessionStart hook ハンドラ。
 *
 * stdin: { hook_event_name: 'SessionStart', session_id, cwd }
 *   実証根拠: openai-codex プラグインの session-lifecycle-hook.mjs が
 *   input.session_id / input.cwd を読み取っている。
 *
 * 処理: cwd を正規化して同プロジェクトの直近Q&A (config.hooks.injectRecentCount件) を
 *       時系列降順で取得し、stdout に additionalContext 形式で返す。
 *
 * 性能目標: 50ms以下 (FTS なし、created_at による直接 ORDER BY)。
 */
export async function handleInject(
  input: { hook_event_name?: string; session_id?: string; cwd?: string },
  configPath?: string,
  projectOverride?: string,
  runtime: HookRuntime = 'claude'
): Promise<string> {
  void runtime;
  const config = loadConfig(configPath);
  const db = getDatabase(config.database.path);

  try {
    initializeSchema(db);
    const store = new Store(db);

    const rawPath = projectOverride || input.cwd || process.cwd();
    let projectPath: string;
    try {
      projectPath = fs.realpathSync(rawPath);
    } catch {
      projectPath = rawPath;
    }

    const limit = Math.max(1, config.hooks.injectRecentCount);

    // 同プロジェクトの直近チャンクを created_at DESC で取得。
    // FTS や ベクトル検索は経由せず、idx_chunks_created を活用する。
    const rows = db
      .prepare(
        `SELECT id, content, session_id AS sessionId, project_path AS projectPath,
                created_at AS createdAt, metadata
         FROM chunks
         WHERE project_path = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(projectPath, limit) as SearchResult[];

    if (rows.length === 0) return '';
    void store;

    // formatResults は ScoredResult を想定しているので、score を仮で乗せる。
    const formatted = rows.map((r, i) => ({ ...r, score: rows.length - i }));
    return formatResults(formatted, limit);
  } finally {
    db.close();
  }
}

export async function runInject(
  configPath?: string,
  projectOverride?: string,
  runtime: HookRuntime = 'claude'
): Promise<void> {
  try {
    const raw = await readStdin();
    let input: { hook_event_name?: string; session_id?: string; cwd?: string } = {};
    if (raw.trim().length > 0) {
      try {
        input = JSON.parse(raw) as typeof input;
      } catch {
        input = {};
      }
    }
    if (runtime === 'kimi') {
      const kimiInput = parseKimiSessionStartInput(raw);
      if (kimiInput) {
        input = {
          hook_event_name: kimiInput.hook_event_name,
          session_id: kimiInput.session_id,
          cwd: kimiInput.cwd,
        };
      }
    }

    const result = await handleInject(input, configPath, projectOverride, runtime);
    if (result) {
      if (runtime === 'codex') {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'SessionStart',
              additionalContext: result,
            },
          })
        );
      } else {
        process.stdout.write(result);
      }
    }
  } catch (err) {
    process.stderr.write(`kizami inject error: ${String(err)}\n`);
    process.exit(0);
  }
}
