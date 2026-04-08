import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../config';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';
import { Store } from '../db/store';
import { parseTranscript } from '../parser/transcript';
import { buildChunks } from '../parser/chunker';

export interface RecoverResult {
  recovered: number;
  skipped: number;
  errors: number;
  details: string[];
}

function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * プロジェクトディレクトリ名からプロジェクトパスを復元する。
 * 例: "-Users-yujiokamoto-devs-claude" → "/Users/yujiokamoto/devs/claude"
 */
export function projectDirToPath(dirName: string): string {
  // 先頭の "-" はルートの "/" に対応
  // 残りの "-" はパスの "/" に対応
  return '/' + dirName.slice(1).replace(/-/g, '/');
}

/**
 * ~/.claude/projects/ 配下のトランスクリプトファイルを走査し、
 * DBに未保存のセッションを検出して保存する。
 */
export async function recoverTranscripts(
  configPath?: string,
  claudeProjectsDir?: string
): Promise<RecoverResult> {
  const config = loadConfig(configPath);
  const db = getDatabase(config.database.path);

  const result: RecoverResult = {
    recovered: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  try {
    initializeSchema(db);
    const store = new Store(db);

    const projectsDir = claudeProjectsDir ?? getClaudeProjectsDir();
    if (!fs.existsSync(projectsDir)) {
      return result;
    }

    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });

    for (const dirent of projectDirs) {
      if (!dirent.isDirectory()) continue;

      const projectDir = path.join(projectsDir, dirent.name);
      const projectPath = projectDirToPath(dirent.name);

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

        const sessionId = entry.name.replace(/\.jsonl$/, '');
        const transcriptPath = path.join(projectDir, entry.name);

        if (store.hasSession(sessionId)) {
          result.skipped++;
          continue;
        }

        try {
          const messages = await parseTranscript(transcriptPath);
          if (messages.length === 0) {
            result.skipped++;
            continue;
          }

          const chunks = buildChunks(messages, sessionId, projectPath);
          if (chunks.length === 0) {
            result.skipped++;
            continue;
          }

          store.insertChunks(chunks);

          const firstHuman = messages.find((m) => m.kind === 'user');
          const lastHuman = [...messages].reverse().find((m) => m.kind === 'user');

          store.insertSession({
            sessionId,
            projectPath,
            startedAt: messages[0].timestamp,
            endedAt: messages[messages.length - 1].timestamp,
            chunkCount: chunks.length,
            firstMessage: firstHuman?.kind === 'user' ? firstHuman.text.slice(0, 200) : undefined,
            lastMessage: lastHuman?.kind === 'user' ? lastHuman.text.slice(0, 200) : undefined,
          });

          result.recovered++;
          result.details.push(`${sessionId.slice(0, 8)} (${chunks.length} chunks)`);
        } catch (err) {
          result.errors++;
          result.details.push(`${sessionId.slice(0, 8)}: error - ${String(err)}`);
        }
      }
    }

    return result;
  } finally {
    db.close();
  }
}
