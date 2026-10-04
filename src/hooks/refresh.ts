import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngramConfig } from '@/config';
import type { Store } from '@/db/store';
import { parseTranscript } from '@/parser/transcript';
import { buildChunks } from '@/parser/chunker';
import { contentDigest } from '@/archive/deletions';
import { readPendingPrompts } from '@/checkpoint/state';
import { buildClaudeTurnCandidates } from '@/checkpoint/adapters/claude';
import { commitCheckpointBatch } from '@/checkpoint/coordinator';
import type { TurnCheckpointCandidate } from '@/checkpoint/types';

/** 取り込んだときの生ログのサイズ。サイズが同じなら解析せずに済ませる。 */
export type RecoverMarks = Map<string, number>;

function marksFile(config: EngramConfig): string {
  return path.join(path.dirname(config.database.path), 'recover-state.json');
}

export function loadRecoverMarks(config: EngramConfig): RecoverMarks {
  const file = marksFile(config);
  if (!fs.existsSync(file)) return new Map();
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { sizes?: Record<string, unknown> };
  const entries = Object.entries(raw.sizes ?? {}).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number'
  );
  return new Map(entries);
}

export function saveRecoverMarks(config: EngramConfig, marks: RecoverMarks): void {
  fs.writeFileSync(marksFile(config), JSON.stringify({ sizes: Object.fromEntries(marks) }));
}

export type RefreshOutcome = 'refreshed' | 'unchanged' | 'skipped';

interface RefreshContext {
  config: EngramConfig;
  store: Store;
  sessionId: string;
  transcriptPath: string;
  marks: RecoverMarks;
  deletedChunkDigests: Set<string>;
}

async function commit(
  config: EngramConfig,
  sessionId: string,
  candidates: TurnCheckpointCandidate[],
  reset: boolean
): Promise<void> {
  await commitCheckpointBatch(
    {
      runtime: 'claude',
      sessionId,
      candidates,
      ...(reset ? { resetReason: 'legacy_mismatch' as const } : {}),
      // Stryker disable next-line ArrayDeclaration: coordinator は runtime の pending ディレクトリ外のパスを消さないので、中身を変えても何も起きない
      finalization: { pendingPaths: [] },
    },
    config
  );
}

/**
 * recover が取り込んだ後に生ログが伸びたセッションへ、伸びた分を反映する。
 * v1 の行が残るセッションは全ターンの v2 baseline で置き換える。v2 だけのセッションは、
 * DB の turnKey がすべて offset:<n> の規則で作られている場合に限り、足りないターンを足す。
 * それ以外の turnKey（未処理の prompt から作る pending:<key>）があれば hook が管理しているので触らない。
 * チャンクの無いセッション行は、保存済みとして扱い触らない。
 * 削除したチャンクを含むセッションも触らない。置き換えると新しい ID で本文が戻るため。
 */
export async function refreshIfGrown(ctx: RefreshContext): Promise<RefreshOutcome> {
  const { config, store, sessionId, transcriptPath, marks } = ctx;
  const size = fs.statSync(transcriptPath).size;
  if (marks.get(sessionId) === size) return 'unchanged';
  const stateRoot = path.dirname(config.database.path);
  if (readPendingPrompts(stateRoot, 'claude', sessionId).length > 0) return 'skipped';
  const session = store.getSession(sessionId);
  if (!session) return 'skipped';

  const messages = await parseTranscript(transcriptPath);
  const chunks = buildChunks(messages, sessionId, session.projectPath);
  if (chunks.some((c) => ctx.deletedChunkDigests.has(contentDigest(c.content)))) return 'skipped';
  const candidates = buildClaudeTurnCandidates(
    messages,
    sessionId,
    session.projectPath,
    size,
    new Date().toISOString()
  );

  const outcome = store.hasLegacyRows(sessionId)
    ? await replaceLegacy(ctx, chunks.length, session.chunkCount ?? 0, candidates)
    : await appendMissingTurns(ctx, candidates);
  // セッション行は checkpoint の反映時に recomputeSessionMetadata が集計し直す。
  if (outcome === 'skipped') return outcome;
  marks.set(sessionId, size);
  return outcome;
}

async function replaceLegacy(
  ctx: RefreshContext,
  chunkCount: number,
  storedChunkCount: number,
  candidates: TurnCheckpointCandidate[]
): Promise<RefreshOutcome> {
  if (chunkCount <= storedChunkCount) return 'unchanged';
  await commit(ctx.config, ctx.sessionId, candidates, true);
  return 'refreshed';
}

async function appendMissingTurns(
  ctx: RefreshContext,
  candidates: TurnCheckpointCandidate[]
): Promise<RefreshOutcome> {
  const known = new Set(candidates.map((c) => c.turnKey));
  const existing = new Set(ctx.store.getSessionTurnKeys(ctx.sessionId));
  if (existing.size === 0 || [...existing].some((key) => !known.has(key))) return 'skipped';
  const missing = candidates.filter((c) => !existing.has(c.turnKey));
  if (missing.length === 0) return 'unchanged';
  await commit(ctx.config, ctx.sessionId, missing, false);
  return 'refreshed';
}
