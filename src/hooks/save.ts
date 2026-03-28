import * as fs from 'node:fs';
import { loadConfig } from '../config';
import { getDatabase } from '../db/connection';
import { initializeSchema } from '../db/schema';
import { Store } from '../db/store';
import { parseTranscript } from '../parser/transcript';
import { buildChunks } from '../parser/chunker';

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
  } finally {
    db.close();
  }
}

export async function runSave(): Promise<void> {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as {
      session_id: string;
      transcript_path: string;
      cwd: string;
    };
    await handleSave(input);
  } catch (err) {
    process.stderr.write(`engram save error: ${String(err)}\n`);
    process.exit(0);
  }
}
