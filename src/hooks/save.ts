import * as fs from 'node:fs';
import { loadConfig } from '@/config';
import { getDatabase } from '@/db/connection';
import { initializeSchema, initializeHybridSchema } from '@/db/schema';
import { Store } from '@/db/store';
import { parseTranscript } from '@/parser/transcript';
import { buildChunks } from '@/parser/chunker';
import { runAutoMaintenance } from '@/maintenance/auto';

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

    const messages = await parseTranscript(input.transcript_path);
    if (messages.length === 0) return;

    const projectPath = fs.realpathSync(input.cwd);
    const chunks = buildChunks(messages, input.session_id, projectPath);

    if (chunks.length === 0) return;

    store.insertChunks(chunks);

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

    // hybridモード: 新チャンクのembeddingを生成
    if (config.search.mode === 'hybrid') {
      try {
        initializeHybridSchema(db, config.embedding.dimensions);

        const { getEmbedding } = await import('../search/embedding');
        const missingIds = store.getChunkIdsWithoutEmbedding();
        const docPrefix = '検索文書: ';
        for (const id of missingIds) {
          const chunk = store.getChunk(id);
          if (chunk) {
            const emb = await getEmbedding(docPrefix + chunk.content.slice(0, 512), config);
            store.insertEmbedding(id, emb);
          }
        }
      } catch (err) {
        process.stderr.write(`kizami hybrid embedding error: ${String(err)}\n`);
      }
    }

    // 自動メンテナンス（頻度制限あり）
    runAutoMaintenance(store, config);
  } finally {
    db.close();
  }
}

export async function runSave(configPath?: string): Promise<void> {
  // SIGINTハンドラはcli.tsのトップレベルで早期登録済み（ここは念のため二重登録）
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});

  try {
    const raw = await readStdin();
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
