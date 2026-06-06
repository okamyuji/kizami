import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema, initializeHybridSchema } from '@/db/schema';
import { Store } from '@/db/store';
import type { Chunk } from '@/db/store';
import type { EngramConfig } from '@/config';
import { JsonlWriter } from '@/jsonl/writer';
import { chunksToJsonlRecords } from '@/jsonl/converter';
import { selfHealFromJsonl } from '@/jsonl/self_heal';
import { runAutoMaintenance } from '@/maintenance/auto';
import { extractMetadata } from '@/parser/metadata';

export interface CodexPromptInput {
  hook_event_name?: string;
  session_id: string;
  turn_id?: string;
  cwd?: string;
  prompt: string;
  model?: string;
}

export interface CodexStopInput {
  hook_event_name?: string;
  session_id: string;
  turn_id?: string;
  cwd?: string;
  transcript_path?: string | null;
  last_assistant_message?: string | null;
  model?: string;
}

interface PendingCodexTurn {
  sessionId: string;
  turnId?: string;
  cwd: string;
  prompt: string;
  model?: string;
  createdAt: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getPendingDir(config: EngramConfig): string {
  return path.join(path.dirname(config.database.path), 'pending', 'codex');
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function pendingKey(sessionId: string, turnId: string | undefined, prompt?: string): string {
  if (turnId) return `${safeFilePart(sessionId)}-${safeFilePart(turnId)}`;
  return `${safeFilePart(sessionId)}-${hashText(prompt ?? sessionId)}`;
}

function pendingPath(
  config: EngramConfig,
  sessionId: string,
  turnId: string | undefined,
  prompt?: string
): string {
  return path.join(getPendingDir(config), `${pendingKey(sessionId, turnId, prompt)}.json`);
}

function findPendingPath(config: EngramConfig, input: CodexStopInput): string | undefined {
  const dir = getPendingDir(config);
  if (input.turn_id) {
    const exact = pendingPath(config, input.session_id, input.turn_id);
    return fs.existsSync(exact) ? exact : undefined;
  }
  if (!fs.existsSync(dir)) return undefined;

  const prefix = `${safeFilePart(input.session_id)}-`;
  const candidates = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.json')
    )
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0]?.filePath;
}

function resolveProjectPath(rawPath: string): string {
  try {
    return fs.realpathSync(rawPath);
  } catch {
    return rawPath;
  }
}

function deterministicExternalId(
  sessionId: string,
  turnId: string | undefined,
  prompt: string,
  assistant: string
): string {
  const hash = createHash('sha256')
    .update('codex')
    .update('\0')
    .update(sessionId)
    .update('\0')
    .update(turnId ?? '')
    .update('\0')
    .update(prompt)
    .update('\0')
    .update(assistant)
    .digest('hex')
    .slice(0, 32);
  return `codex-${hash}`;
}

function getNextChunkIndex(store: Store, sessionId: string): number {
  return store.getMaxChunkIndex(sessionId) + 1;
}

export function savePendingCodexPrompt(input: CodexPromptInput, configPath?: string): void {
  if (!input.session_id || !input.prompt) return;

  const config = loadConfig(configPath);
  const cwd = input.cwd ?? process.cwd();
  const pending: PendingCodexTurn = {
    sessionId: input.session_id,
    turnId: input.turn_id,
    cwd,
    prompt: input.prompt,
    model: input.model,
    createdAt: new Date().toISOString(),
  };

  const dir = getPendingDir(config);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    pendingPath(config, input.session_id, input.turn_id, input.prompt),
    JSON.stringify(pending),
    {
      encoding: 'utf-8',
      mode: 0o600,
    }
  );
}

export async function handleCodexStop(input: CodexStopInput, configPath?: string): Promise<void> {
  const assistant = input.last_assistant_message?.trim();
  if (!input.session_id || !assistant) return;

  const config = loadConfig(configPath);
  const filePath = findPendingPath(config, input);
  if (!filePath) return;

  let pending: PendingCodexTurn;
  try {
    pending = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PendingCodexTurn;
  } catch {
    fs.rmSync(filePath, { force: true });
    return;
  }

  const db = getDatabase(config.database.path);
  try {
    initializeSchema(db);
    const store = new Store(db);
    try {
      selfHealFromJsonl(store, config.storage.jsonlDir, config.storage.selfHealTailLines);
    } catch {
      // A failed preflight self-heal should not prevent saving the current turn.
    }

    const projectPath = resolveProjectPath(input.cwd ?? pending.cwd);
    const createdAt = new Date().toISOString();
    const content = `[User]\n${pending.prompt}\n\n[Assistant]\n${assistant}`;
    const externalId = deterministicExternalId(
      input.session_id,
      input.turn_id ?? pending.turnId,
      pending.prompt,
      assistant
    );
    if (store.getChunkIdByExternalId(externalId) !== undefined) {
      fs.rmSync(filePath, { force: true });
      return;
    }
    const metadata = {
      ...extractMetadata(content),
      sourceRuntime: 'codex',
      captureMethod: 'hooks',
      turnId: input.turn_id ?? pending.turnId ?? null,
      model: input.model ?? pending.model ?? null,
    };
    const embeddings = new Map<number, { vec: Float32Array; model: string }>();
    if (config.search.mode === 'hybrid') {
      try {
        initializeHybridSchema(db, config.embedding.dimensions);
        const { getEmbedding } = await import('../search/embedding');
        const vec = await getEmbedding('検索文書: ' + content.slice(0, 512), config);
        embeddings.set(0, { vec, model: config.embedding.model });
      } catch (err) {
        process.stderr.write(`kizami codex hybrid embedding error (skipped): ${String(err)}\n`);
      }
    }

    let chunk: Chunk | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate: Chunk = {
        externalId,
        sessionId: input.session_id,
        projectPath,
        chunkIndex: getNextChunkIndex(store, input.session_id),
        content,
        role: 'mixed',
        metadata,
        tokenCount: estimateTokens(content),
        createdAt,
      };
      const inserted = store.appendChunksWithoutReplace([candidate]);
      if (inserted > 0) {
        chunk = candidate;
        break;
      }
      if (store.getChunkIdByExternalId(externalId) !== undefined) break;
    }
    if (!chunk) {
      fs.rmSync(filePath, { force: true });
      return;
    }

    const writer = new JsonlWriter(config.storage.jsonlDir);
    writer.appendRecords(chunksToJsonlRecords([chunk], embeddings));
    if (embeddings.size > 0) {
      const chunkId = store.getChunkIdByExternalId(externalId);
      const embedding = embeddings.get(0);
      if (chunkId !== undefined && embedding) {
        store.insertEmbedding(chunkId, embedding.vec);
      }
    }

    const existing = store.getSession(input.session_id);
    const firstMessage = existing?.firstMessage ?? pending.prompt.slice(0, 200);
    store.insertSession({
      sessionId: input.session_id,
      projectPath,
      startedAt: existing?.startedAt ?? pending.createdAt,
      endedAt: createdAt,
      chunkCount: store.countChunksForSession(input.session_id),
      firstMessage,
      lastMessage: pending.prompt.slice(0, 200),
    });

    try {
      selfHealFromJsonl(store, config.storage.jsonlDir, config.storage.selfHealTailLines);
    } catch (err) {
      process.stderr.write(`kizami codex self-heal error (non-fatal): ${String(err)}\n`);
    }
    runAutoMaintenance(store, config);
    fs.rmSync(filePath, { force: true });
  } finally {
    db.close();
  }
}
