import { parseArgs } from 'node:util';
import * as path from 'node:path';
import { loadConfig } from './config';
import { getDatabase } from './db/connection';
import { initializeSchema } from './db/schema';
import { Store } from './db/store';
import type { StoreStats, Session } from './db/store';
import { searchFts } from './search/fts';
import { rankResults } from './search/hybrid';
import type { ScoredResult } from './search/hybrid';
import { formatResults } from './search/formatter';
import { runSave } from './hooks/save';
import { runRecall } from './hooks/recall';
import { setupHooks } from './hooks/setup';
import { importClaudeMem } from './import/claude-mem';
import type { ImportResult } from './import/claude-mem';
import { mergeChunks } from './maintenance/merge';
import type { MergeResult } from './maintenance/merge';
import { recoverTranscripts } from './hooks/recover';
import type { RecoverResult } from './hooks/recover';

// ── Helpers ──────────────────────────────────────────────────────────

function createStore(configPath?: string): { store: Store; close: () => void } {
  const config = loadConfig(configPath);
  const db = getDatabase(config.database.path);
  initializeSchema(db);
  return { store: new Store(db), close: () => db.close() };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseDuration(value: string): number {
  const match = value.match(/^(\d+)([dhm])$/);
  if (!match) throw new Error(`Invalid duration: ${value}. Use format like 90d, 24h, 60m`);
  const num = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'd':
      return num * 86400000;
    case 'h':
      return num * 3600000;
    case 'm':
      return num * 60000;
    default:
      throw new Error(`Unknown unit: ${unit}`);
  }
}

// ── Command Handlers ─────────────────────────────────────────────────

export async function cmdSave(stdin: boolean, configPath?: string): Promise<void> {
  if (!stdin) {
    console.log('Usage: kizami save --stdin');
    console.log('  Reads JSON from stdin (SessionEnd hook).');
    return;
  }
  await runSave(configPath);
}

export async function cmdRecall(
  stdin: boolean,
  configPath?: string,
  projectPath?: string
): Promise<void> {
  if (!stdin) {
    console.log('Usage: kizami recall --stdin');
    console.log('  Reads JSON from stdin (UserPromptSubmit hook).');
    return;
  }
  await runRecall(configPath, projectPath);
}

export function cmdSearch(
  query: string,
  options: { project?: string; allProjects?: boolean; config?: string }
): ScoredResult[] {
  const { store, close } = createStore(options.config);
  try {
    const projectPath = options.project ? path.resolve(options.project) : process.cwd();
    const config = loadConfig(options.config);

    const results = searchFts(store, {
      query,
      projectPath,
      limit: 50,
      allProjects: options.allProjects ?? false,
    });

    if (results.length === 0) {
      console.log('No results found.');
      return [];
    }

    const ranked = rankResults(results, config.search.timeDecayHalfLifeDays, query);
    const output = formatResults(ranked, config.search.defaultLimit);
    console.log(output);
    return ranked;
  } finally {
    close();
  }
}

export function cmdEdit(chunkId: number, content: string, options: { config?: string }): void {
  const { store, close } = createStore(options.config);
  try {
    const existing = store.getChunk(chunkId);
    if (!existing) {
      console.error(`Chunk ${chunkId} not found.`);
      process.exitCode = 1;
      return;
    }
    store.updateChunkContent(chunkId, content);
    console.log(`Chunk ${chunkId} updated.`);
  } finally {
    close();
  }
}

export function cmdDelete(options: {
  session?: string;
  before?: string;
  chunk?: string;
  config?: string;
}): void {
  const { store, close } = createStore(options.config);
  try {
    if (options.session) {
      store.deleteSession(options.session);
      console.log(`Session ${options.session} deleted.`);
    } else if (options.before) {
      const date = new Date(options.before).toISOString();
      const count = store.deleteChunksBefore(date);
      console.log(`Deleted ${count} chunks before ${options.before}.`);
    } else if (options.chunk) {
      const id = parseInt(options.chunk, 10);
      if (isNaN(id)) {
        console.error('Invalid chunk ID.');
        process.exitCode = 1;
        return;
      }
      store.deleteChunk(id);
      console.log(`Chunk ${id} deleted.`);
    } else {
      console.log('Usage: kizami delete --session <id> | --before <date> | --chunk <id>');
    }
  } finally {
    close();
  }
}

export function cmdList(options: {
  project?: string;
  allProjects?: boolean;
  config?: string;
}): Session[] {
  const { store, close } = createStore(options.config);
  try {
    const projectPath = options.allProjects
      ? undefined
      : options.project
        ? path.resolve(options.project)
        : process.cwd();
    const sessions = store.getSessionList(projectPath);

    if (sessions.length === 0) {
      console.log('No sessions found.');
      return sessions;
    }

    console.log(
      `${'ID'.padEnd(10)} ${'Project'.padEnd(30)} ${'Date'.padEnd(12)} ${'Chunks'.padEnd(8)} First Message`
    );
    console.log('-'.repeat(90));

    for (const s of sessions) {
      const id = s.sessionId.slice(0, 8);
      const proj = s.projectPath.length > 28 ? '...' + s.projectPath.slice(-25) : s.projectPath;
      const date = s.endedAt ? s.endedAt.slice(0, 10) : '—';
      const chunks = String(s.chunkCount ?? 0);
      const msg = (s.firstMessage ?? '').slice(0, 40);
      console.log(
        `${id.padEnd(10)} ${proj.padEnd(30)} ${date.padEnd(12)} ${chunks.padEnd(8)} ${msg}`
      );
    }

    return sessions;
  } finally {
    close();
  }
}

export function cmdStats(options: { config?: string }): StoreStats {
  const { store, close } = createStore(options.config);
  try {
    const stats = store.getStats();
    console.log(`Chunks:    ${stats.totalChunks}`);
    console.log(`Sessions:  ${stats.totalSessions}`);
    console.log(`DB size:   ${formatBytes(stats.dbSizeBytes)}`);
    return stats;
  } finally {
    close();
  }
}

export async function cmdSetup(hybrid: boolean): Promise<void> {
  await setupHooks({ hybrid });
}

export function cmdPrune(olderThan: string, options: { config?: string }): number {
  const ms = parseDuration(olderThan);
  const cutoff = new Date(Date.now() - ms).toISOString();

  const { store, close } = createStore(options.config);
  try {
    const count = store.deleteChunksBefore(cutoff);
    console.log(`Pruned ${count} chunks older than ${olderThan}.`);
    return count;
  } finally {
    close();
  }
}

export function cmdExport(options: {
  format?: string;
  project?: string;
  allProjects?: boolean;
  config?: string;
}): string {
  const fmt = options.format ?? 'json';
  const { store, close } = createStore(options.config);
  try {
    const projectPath = options.allProjects
      ? undefined
      : options.project
        ? path.resolve(options.project)
        : process.cwd();
    const sessions = store.getSessionList(projectPath);

    if (fmt === 'markdown') {
      const lines: string[] = ['# Engram Memory Export\n'];
      for (const s of sessions) {
        lines.push(`## Session ${s.sessionId.slice(0, 8)}`);
        lines.push(`- Project: ${s.projectPath}`);
        lines.push(`- Date: ${s.endedAt ?? '—'}`);
        lines.push(`- Chunks: ${s.chunkCount ?? 0}`);
        if (s.firstMessage) lines.push(`- First: ${s.firstMessage}`);
        lines.push('');
      }
      const output = lines.join('\n');
      console.log(output);
      return output;
    }

    // Default: JSON
    const output = JSON.stringify(sessions, null, 2);
    console.log(output);
    return output;
  } finally {
    close();
  }
}

export async function cmdImportClaudeMem(options: {
  source?: string;
  project?: string;
  dryRun?: boolean;
  config?: string;
}): Promise<ImportResult> {
  const result = await importClaudeMem({
    sourcePath: options.source,
    configPath: options.config,
    project: options.project,
    dryRun: options.dryRun,
  });

  if (options.dryRun) {
    console.log('Dry run — no data was imported.');
  }
  console.log(`Sessions imported: ${result.sessionsImported}`);
  console.log(`Chunks imported:   ${result.chunksImported}`);
  console.log(`Skipped:           ${result.skipped}`);
  return result;
}

export function cmdMerge(options: {
  threshold?: string;
  project?: string;
  dryRun?: boolean;
  config?: string;
}): MergeResult {
  const config = loadConfig(options.config);
  const db = getDatabase(config.database.path);
  initializeSchema(db);

  try {
    const threshold = options.threshold ? parseFloat(options.threshold) : undefined;
    const result = mergeChunks(db, {
      similarityThreshold: threshold,
      projectPath: options.project ? path.resolve(options.project) : undefined,
      dryRun: options.dryRun,
    });

    if (options.dryRun) {
      console.log('Dry run — no data was modified.');
    }
    console.log(`Similar groups found: ${result.groupsFound}`);
    console.log(`Chunks in groups:    ${result.chunksMerged}`);
    console.log(`Chunks removed:      ${result.chunksRemoved}`);
    return result;
  } finally {
    db.close();
  }
}

export async function cmdRecover(options: { config?: string }): Promise<RecoverResult> {
  const result = await recoverTranscripts(options.config);
  if (result.recovered === 0 && result.errors === 0) {
    console.log('No unsaved transcripts found.');
  } else {
    console.log(`Recovered: ${result.recovered}`);
    console.log(`Skipped:   ${result.skipped}`);
    console.log(`Errors:    ${result.errors}`);
    if (result.details.length > 0) {
      console.log('\nDetails:');
      for (const d of result.details) {
        console.log(`  ${d}`);
      }
    }
  }
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────

function showUsage(): void {
  console.log(`kizami <command> [options]

Commands:
  save              Save transcript (SessionEnd hook, reads stdin)
  recall            Search and output memories (UserPromptSubmit hook, reads stdin)
  search <query>    Interactively search memories
  edit <chunk-id>   Edit chunk content (--content <text>)
  delete            Delete chunks/sessions/by date
  list              List sessions
  stats             Show statistics
  setup             Auto-configure Claude Code hooks
  prune             Bulk delete old memories
  export            Export as JSON/Markdown
  merge             Merge similar chunks
  recover           Recover unsaved transcripts from ~/.claude/projects/
  import-claude-mem Import from claude-mem database

Options:
  --project <path>    Project path
  --all-projects      Search across all projects
  --config <path>     Config file path
  --stdin             Read input from stdin (for hooks)`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      stdin: { type: 'boolean', default: false },
      project: { type: 'string' },
      'all-projects': { type: 'boolean', default: false },
      config: { type: 'string' },
      content: { type: 'string' },
      session: { type: 'string' },
      before: { type: 'string' },
      chunk: { type: 'string' },
      'older-than': { type: 'string' },
      format: { type: 'string' },
      source: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      threshold: { type: 'string' },
      hybrid: { type: 'boolean', default: false },
    },
  });

  const command = positionals[0];

  if (!command) {
    showUsage();
    return;
  }

  const sharedOpts = {
    project: values['project'] as string | undefined,
    allProjects: values['all-projects'] as boolean | undefined,
    config: values['config'] as string | undefined,
  };

  switch (command) {
    case 'save':
      await cmdSave(!!values['stdin'], sharedOpts.config);
      break;

    case 'recall':
      await cmdRecall(!!values['stdin'], sharedOpts.config, sharedOpts.project);
      break;

    case 'search': {
      const query = positionals.slice(1).join(' ');
      if (!query) {
        console.error('Usage: kizami search <query>');
        process.exitCode = 1;
        return;
      }
      cmdSearch(query, sharedOpts);
      break;
    }

    case 'edit': {
      const idStr = positionals[1];
      const content = values['content'] as string | undefined;
      if (!idStr || !content) {
        console.error('Usage: kizami edit <chunk-id> --content <text>');
        process.exitCode = 1;
        return;
      }
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        console.error('Invalid chunk ID.');
        process.exitCode = 1;
        return;
      }
      cmdEdit(id, content, { config: sharedOpts.config });
      break;
    }

    case 'delete':
      cmdDelete({
        session: values['session'] as string | undefined,
        before: values['before'] as string | undefined,
        chunk: values['chunk'] as string | undefined,
        config: sharedOpts.config,
      });
      break;

    case 'list':
      cmdList(sharedOpts);
      break;

    case 'stats':
      cmdStats({ config: sharedOpts.config });
      break;

    case 'setup':
      await cmdSetup(!!values['hybrid']);
      break;

    case 'prune': {
      const olderThan = values['older-than'] as string | undefined;
      if (!olderThan) {
        console.error('Usage: kizami prune --older-than <duration>  (e.g., 90d, 24h)');
        process.exitCode = 1;
        return;
      }
      cmdPrune(olderThan, { config: sharedOpts.config });
      break;
    }

    case 'export':
      cmdExport({
        format: values['format'] as string | undefined,
        ...sharedOpts,
      });
      break;

    case 'merge':
      cmdMerge({
        threshold: values['threshold'] as string | undefined,
        project: sharedOpts.project,
        dryRun: values['dry-run'] as boolean | undefined,
        config: sharedOpts.config,
      });
      break;

    case 'recover':
      await cmdRecover({ config: sharedOpts.config });
      break;

    case 'import-claude-mem':
      await cmdImportClaudeMem({
        source: values['source'] as string | undefined,
        project: sharedOpts.project,
        dryRun: values['dry-run'] as boolean | undefined,
        config: sharedOpts.config,
      });
      break;

    default:
      console.error(`Unknown command: ${command}`);
      process.exitCode = 1;
  }
}

// SessionEnd hookではCtrl+C等のSIGINTがプロセスに到達する。
// 主防御はhook commandのbash trap（setup.ts参照）だが、
// ESMのimport解決後・main()前にも二重で登録しておく。
if (process.argv[2] === 'save' || process.argv[2] === 'recall') {
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
}

main().catch((err) => {
  console.error(`kizami error: ${String(err)}`);
  process.exitCode = 1;
});
