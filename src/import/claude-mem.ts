import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../config';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';
import { Store } from '../db/store';
import type { Chunk, Session } from '../db/store';

export interface ImportOptions {
  sourcePath?: string; // claude-mem DB path, default ~/.claude-mem/claude-mem.db
  configPath?: string; // kizami config path
  project?: string; // filter by project name
  dryRun?: boolean; // just report counts, don't import
}

export interface ImportResult {
  sessionsImported: number;
  chunksImported: number;
  skipped: number; // already imported
}

interface ClaudeMemSession {
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  user_prompt: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ClaudeMemObservation {
  id: number;
  memory_session_id: string;
  project: string;
  type: string;
  title: string | null;
  narrative: string | null;
  facts: string | null;
  files_read: string | null;
  files_modified: string | null;
  created_at: string;
}

interface ClaudeMemSummary {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  created_at: string;
}

function getDefaultSourcePath(): string {
  return path.join(os.homedir(), '.claude-mem', 'claude-mem.db');
}

function parseFileList(value: string | null): string[] {
  if (!value || value.trim() === '') return [];

  // Try JSON array first
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    }
  } catch {
    // Not JSON, try comma-separated
  }

  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function formatObservation(obs: ClaudeMemObservation): string {
  const parts: string[] = [`[claude-mem observation: ${obs.type}]`];
  if (obs.title) parts.push(obs.title);
  parts.push(''); // blank line
  if (obs.narrative) parts.push(obs.narrative);
  if (obs.facts) parts.push('', obs.facts);
  return parts.join('\n');
}

function formatSummary(summary: ClaudeMemSummary): string {
  const parts: string[] = ['[claude-mem summary]'];
  if (summary.request) parts.push(`Request: ${summary.request}`);
  if (summary.investigated) parts.push(`Investigated: ${summary.investigated}`);
  if (summary.learned) parts.push(`Learned: ${summary.learned}`);
  if (summary.completed) parts.push(`Completed: ${summary.completed}`);
  if (summary.next_steps) parts.push(`Next steps: ${summary.next_steps}`);
  return parts.join('\n');
}

function observationToChunk(obs: ClaudeMemObservation, chunkIndex: number): Chunk {
  const content = formatObservation(obs);
  const filePaths = [...parseFileList(obs.files_read), ...parseFileList(obs.files_modified)];

  return {
    sessionId: obs.memory_session_id,
    projectPath: `claude-mem:${obs.project}`,
    chunkIndex,
    content,
    role: 'mixed',
    metadata: {
      filePaths,
      toolNames: [obs.type],
      errorMessages: [],
    },
    tokenCount: Math.ceil(content.length / 4),
  };
}

function summaryToChunk(summary: ClaudeMemSummary, chunkIndex: number): Chunk {
  const content = formatSummary(summary);
  const filePaths = [...parseFileList(summary.files_read), ...parseFileList(summary.files_edited)];

  return {
    sessionId: summary.memory_session_id,
    projectPath: `claude-mem:${summary.project}`,
    chunkIndex,
    content,
    role: 'mixed',
    metadata: {
      filePaths,
      toolNames: [],
      errorMessages: [],
    },
    tokenCount: Math.ceil(content.length / 4),
  };
}

export async function importClaudeMem(options?: ImportOptions): Promise<ImportResult> {
  const sourcePath = options?.sourcePath ?? getDefaultSourcePath();
  const config = loadConfig(options?.configPath);
  const dryRun = options?.dryRun ?? false;

  // Open claude-mem DB read-only
  const sourceDb = new Database(sourcePath, { readonly: true });

  // Open kizami DB
  const kizamiDb = getDatabase(config.database.path);
  initializeSchema(kizamiDb);
  const store = new Store(kizamiDb);

  try {
    // Read sessions from claude-mem
    let sessions: ClaudeMemSession[];
    if (options?.project) {
      sessions = sourceDb
        .prepare(
          `SELECT content_session_id, memory_session_id, project, user_prompt, started_at, completed_at
           FROM sdk_sessions WHERE project = ?`
        )
        .all(options.project) as ClaudeMemSession[];
    } else {
      sessions = sourceDb
        .prepare(
          `SELECT content_session_id, memory_session_id, project, user_prompt, started_at, completed_at
           FROM sdk_sessions`
        )
        .all() as ClaudeMemSession[];
    }

    let sessionsImported = 0;
    let chunksImported = 0;
    let skipped = 0;

    for (const sess of sessions) {
      const sessionId = sess.memory_session_id;
      if (!sessionId) {
        skipped++;
        continue;
      }

      // Check if already imported by looking for existing chunks with this sessionId
      const existing = kizamiDb
        .prepare('SELECT COUNT(*) as count FROM chunks WHERE session_id = ?')
        .get(sessionId) as { count: number };

      if (existing.count > 0) {
        skipped++;
        continue;
      }

      // Get observations for this session
      const observations = sourceDb
        .prepare(
          `SELECT id, memory_session_id, project, type, title, narrative, facts,
                  files_read, files_modified, created_at
           FROM observations WHERE memory_session_id = ?
           ORDER BY id`
        )
        .all(sessionId) as ClaudeMemObservation[];

      // Get summaries for this session
      const summaries = sourceDb
        .prepare(
          `SELECT id, memory_session_id, project, request, investigated, learned,
                  completed, next_steps, files_read, files_edited, created_at
           FROM session_summaries WHERE memory_session_id = ?
           ORDER BY id`
        )
        .all(sessionId) as ClaudeMemSummary[];

      if (observations.length === 0 && summaries.length === 0) {
        skipped++;
        continue;
      }

      if (dryRun) {
        sessionsImported++;
        chunksImported += observations.length + summaries.length;
        continue;
      }

      // Convert observations to chunks
      const chunks: Chunk[] = [];
      observations.forEach((obs, idx) => {
        chunks.push(observationToChunk(obs, idx));
      });

      // Convert summaries to chunks (offset by 10000 to avoid collision)
      summaries.forEach((summary, idx) => {
        chunks.push(summaryToChunk(summary, 10000 + idx));
      });

      // Insert chunks
      store.insertChunks(chunks);

      // Insert session
      const projectPath = `claude-mem:${sess.project}`;
      const session: Session = {
        sessionId,
        projectPath,
        startedAt: sess.started_at,
        endedAt: sess.completed_at ?? undefined,
        chunkCount: chunks.length,
        firstMessage: sess.user_prompt ? sess.user_prompt.slice(0, 200) : undefined,
      };
      store.insertSession(session);

      sessionsImported++;
      chunksImported += chunks.length;
    }

    return { sessionsImported, chunksImported, skipped };
  } finally {
    sourceDb.close();
    kizamiDb.close();
  }
}
