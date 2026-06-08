import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema, initializeHybridSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { parseTranscript } from '@/parser/transcript';
import { buildChunks } from '@/parser/chunker';
import { runAutoMaintenance } from '@/maintenance/auto';
import { JsonlWriter } from '@/jsonl/writer';
import { chunksToJsonlRecords } from '@/jsonl/converter';
import { selfHealFromJsonl } from '@/jsonl/self_heal';
import { handleCodexStop } from '@/hooks/codex';
import {
  parseKimiSessionEndInput,
  collectPendingKimiTurns,
  findWireJsonlPath,
  extractAssistantFromWireJsonl,
} from '@/hooks/kimi';
import { extractMetadata } from '@/parser/metadata';
import type { Chunk } from '@/db/store';
import type { HookRuntime } from '@/hooks/recall';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function handleSave(
  input: {
    session_id: string;
    transcript_path: string;
    cwd: string;
  },
  configPath?: string
): Promise<void> {
  const config = loadConfig(configPath);
  const db = getDatabase(config.database.path);

  try {
    initializeSchema(db);
    const store = new Store(db);

    // transcript の jsonl は Claude Code 側が rotate/削除することがあるため、
    // 既に存在しない場合は silently skip する (ハーネス由来の状態でユーザー対処不能)。
    if (!fs.existsSync(input.transcript_path)) return;

    const messages = await parseTranscript(input.transcript_path);
    if (messages.length === 0) return;

    let projectPath: string;
    try {
      projectPath = fs.realpathSync(input.cwd);
    } catch {
      projectPath = input.cwd || process.cwd();
    }
    const chunks = buildChunks(messages, input.session_id, projectPath);

    if (chunks.length === 0) return;

    // hybrid モード: SQLite 挿入前に embedding を生成し、JSONL に同梱できるようにする。
    // モデルロードに失敗しても本体保存は継続する（graceful: embedding なしで進む）。
    const embeddings = new Map<number, { vec: Float32Array; model: string }>();
    if (config.search.mode === 'hybrid') {
      try {
        initializeHybridSchema(db, config.embedding.dimensions);
        const { getEmbedding } = await import('../search/embedding');
        const docPrefix = '検索文書: ';
        for (let i = 0; i < chunks.length; i++) {
          const vec = await getEmbedding(docPrefix + chunks[i].content.slice(0, 512), config);
          embeddings.set(i, { vec, model: config.embedding.model });
        }
      } catch (err) {
        process.stderr.write(`kizami hybrid embedding error (skipped): ${String(err)}\n`);
      }
    }

    // chunks に externalId/createdAt を割り当ててから JSONL に先書きする。
    // 失敗した場合は SQLite を一切触らずに例外を伝播するフェイルファスト方針（設計書 §3.3）。
    for (const c of chunks) {
      if (!c.externalId) c.externalId = randomUUID();
      if (!c.createdAt) c.createdAt = new Date().toISOString();
    }
    const records = chunksToJsonlRecords(chunks, embeddings);
    const writer = new JsonlWriter(config.storage.jsonlDir);
    writer.appendRecords(records);

    // SQLite 挿入（既存ロジック維持）
    store.insertChunks(chunks);

    // hybridモード: 生成済み embedding を chunks_vec に書き戻す。
    if (embeddings.size > 0) {
      for (const [idx, { vec }] of embeddings) {
        const externalId = chunks[idx].externalId;
        if (!externalId) continue;
        const chunkId = store.getChunkIdByExternalId(externalId);
        if (chunkId !== undefined) {
          store.insertEmbedding(chunkId, vec);
        }
      }
    }

    // Extract first/last human messages for session metadata
    const firstHuman = messages.find((m) => m.kind === 'user');
    const lastHuman = [...messages].reverse().find((m) => m.kind === 'user');

    store.insertSession({
      sessionId: input.session_id,
      projectPath,
      startedAt: messages[0].timestamp,
      endedAt: messages[messages.length - 1].timestamp,
      chunkCount: chunks.length,
      firstMessage: firstHuman?.kind === 'user' ? firstHuman.text.slice(0, 200) : undefined,
      lastMessage: lastHuman?.kind === 'user' ? lastHuman.text.slice(0, 200) : undefined,
    });

    // self-healing: JSONL末尾とSQLiteの整合を確認。通常は何もせず数ms。
    try {
      selfHealFromJsonl(store, config.storage.jsonlDir, config.storage.selfHealTailLines);
    } catch (err) {
      process.stderr.write(`kizami self-heal error (non-fatal): ${String(err)}\n`);
    }

    // 自動メンテナンス（頻度制限あり）
    runAutoMaintenance(store, config);
  } finally {
    db.close();
  }
}

export async function runSave(configPath?: string, runtime: HookRuntime = 'claude'): Promise<void> {
  // SIGINTハンドラはcli.tsのトップレベルで早期登録済み（ここは念のため二重登録）
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});

  try {
    const raw = await readStdin();
    if (runtime === 'kimi') {
      await handleKimiSessionEnd(raw, configPath);
      return;
    }
    if (runtime === 'codex') {
      const input = JSON.parse(raw) as {
        session_id: string;
        turn_id?: string;
        cwd?: string;
        transcript_path?: string | null;
        last_assistant_message?: string | null;
        model?: string;
      };
      await handleCodexStop(input, configPath);
      return;
    }
    const input = JSON.parse(raw) as {
      session_id: string;
      transcript_path: string;
      cwd: string;
    };
    await handleSave(input, configPath);
  } catch (err) {
    process.stderr.write(`kizami save error: ${String(err)}\n`);
    process.exit(0);
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function resolveProjectPath(rawPath: string): string {
  try {
    return fs.realpathSync(rawPath);
  } catch {
    return rawPath;
  }
}

async function handleKimiSessionEnd(raw: string, configPath?: string): Promise<void> {
  const parsed = parseKimiSessionEndInput(raw);
  if (!parsed) return;

  const config = loadConfig(configPath);
  const pendingDir = path.join(path.dirname(config.database.path), 'pending', 'kimi');
  const turns = collectPendingKimiTurns(parsed.session_id, pendingDir, true);
  if (turns.length === 0) return;

  const wirePath = findWireJsonlPath(parsed.session_id);
  const assistantText = wirePath ? extractAssistantFromWireJsonl(wirePath) : '';

  const projectPath = resolveProjectPath(parsed.cwd ?? turns[0].cwd);
  const allPrompts = turns.map((t) => t.prompt).join('\n\n');
  const content = assistantText
    ? `[User]\n${allPrompts}\n\n[Assistant]\n${assistantText}`
    : `[User]\n${allPrompts}`;

  if (!assistantText) return;

  const db = getDatabase(config.database.path);
  try {
    initializeSchema(db);
    const store = new Store(db);
    try {
      selfHealFromJsonl(store, config.storage.jsonlDir, config.storage.selfHealTailLines);
    } catch {
      /* non-blocking */
    }

    const createdAt = new Date().toISOString();
    const { createHash } = await import('node:crypto');
    const externalId = `kimi-${createHash('sha256').update(parsed.session_id).update('\0').update(allPrompts).update('\0').update(assistantText).digest('hex').slice(0, 32)}`;

    if (store.getChunkIdByExternalId(externalId) !== undefined) return;

    const metadata = {
      ...extractMetadata(content),
      sourceRuntime: 'kimi',
      captureMethod: 'hooks',
    };

    const embeddings = new Map<number, { vec: Float32Array; model: string }>();
    if (config.search.mode === 'hybrid') {
      try {
        initializeHybridSchema(db, config.embedding.dimensions);
        const { getEmbedding } = await import('../search/embedding');
        const vec = await getEmbedding('検索文書: ' + content.slice(0, 512), config);
        embeddings.set(0, { vec, model: config.embedding.model });
      } catch (err) {
        process.stderr.write(`kizami kimi hybrid embedding error (skipped): ${String(err)}\n`);
      }
    }

    const chunk: Chunk = {
      externalId,
      sessionId: parsed.session_id,
      projectPath,
      chunkIndex: store.getMaxChunkIndex(parsed.session_id) + 1,
      content,
      role: 'mixed',
      metadata,
      tokenCount: estimateTokens(content),
      createdAt,
    };

    const inserted = store.appendChunksWithoutReplace([chunk]);
    if (inserted === 0) return;

    const writer = new JsonlWriter(config.storage.jsonlDir);
    writer.appendRecords(chunksToJsonlRecords([chunk], embeddings));

    runAutoMaintenance(store, config);
  } finally {
    db.close();
  }
}
