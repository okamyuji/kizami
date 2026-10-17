import type { EngramConfig } from '@/config';
import type { Chunk, Store } from '@/db/store';
import type { CanonicalHistory } from '@/jsonl/fold';
import { appendChunkDeletions } from '@/jsonl/deletion';
import { JsonlTransactionWriter, JsonlWriter } from '@/jsonl/writer';
import type { LockedJsonlWriter } from '@/jsonl/writer';
import { serializeV2Transaction } from '@/jsonl/transaction';
import { getJsonlFilePath } from '@/jsonl/path';
import { chunksToJsonlRecords } from '@/jsonl/converter';
import type { JsonlChunkRecord } from '@/jsonl/types';
import { buildCheckpointParts } from '@/checkpoint/builder';
import { createContentHash, hashFields } from '@/checkpoint/identity';
import type { TurnCheckpointV2 } from '@/checkpoint/types';
import { detectRole, estimateTokens, splitTurnText, turnToText } from '@/parser/chunker';
import { extractMetadata } from '@/parser/metadata';

/**
 * Claude Code が API へ送った本文の写し（api-request-blob 行）を発言として保存したターンの書き出し。
 * 写しは system-reminder のブロックで始まり、その後ろに本物のプロンプトが続く。
 * 実データでは、正規の会話のターンはこの形で始まらなかった。
 */
export const REQUEST_COPY_SIGNATURE = '[User]\n<system-reminder>';
const ASSISTANT_HEADER = '\n\n[Assistant]\n';
const REMINDER_END = '</system-reminder>';
/** 写しを除いて書き直した v1 の行の ID に付ける。元の行の ID から決まるので、途中で止まった回の後も同じ行を二度足さない。 */
const TRIMMED_ID = '-trimmed-';

/**
 * 写しを除いたプロンプトと回答。写しは [User] 節の先頭から、その節の最後の閉じタグまでとする。
 * 写しの中で閉じタグが引用されていても止まらないため。プロンプトが閉じタグを含めば、その手前まで消える。
 * 閉じタグが無ければ [User] 節全体を写しとみなす。
 */
export function stripRequestCopy(text: string): { prompt: string; assistant: string } {
  const at = text.indexOf(ASSISTANT_HEADER);
  const user = at < 0 ? text : text.slice(0, at);
  const assistant = at < 0 ? '' : text.slice(at + ASSISTANT_HEADER.length);
  const end = user.lastIndexOf(REMINDER_END);
  const prompt = end < 0 ? '' : user.slice(end + REMINDER_END.length).trim();
  return { prompt, assistant };
}

/** セッションごとの、写しを含むターン。v1 は 1 ターン分の行の並び。 */
export interface CopyTurns {
  v2: Map<string, TurnCheckpointV2[]>;
  v1: Map<string, JsonlChunkRecord[][]>;
  /** 正本で採用されている v1 の行の ID。 */
  legacyIds: Set<string>;
}

function push<T>(map: Map<string, T[]>, key: string, item: T): void {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

/** v1 の行は長いターンを部品に分けて持つ。写しで始まる行から、次のターンの行の手前までを 1 ターンとする。 */
function legacyCopyTurns(records: JsonlChunkRecord[]): JsonlChunkRecord[][] {
  const found: JsonlChunkRecord[][] = [];
  let current: JsonlChunkRecord[] | undefined;
  for (const record of [...records].sort((a, b) => a.chunkIndex - b.chunkIndex)) {
    // 書き直した行は元の行と同じ番号を持つので、元の行が残っている間はどちらの並びにも入れない
    if (record.id.includes(TRIMMED_ID)) continue;
    if (record.content.startsWith(REQUEST_COPY_SIGNATURE)) {
      current = [record];
      found.push(current);
    } else if (record.content.startsWith('[User]\n')) {
      // shortcut: 部品が段落頭の [User] で始まると、そこでターンが切れたとみなす。実データの写しはそうならなかった
      current = undefined;
    } else {
      current?.push(record);
    }
  }
  return found;
}

/** 正本で採用されている記録のうち、写しを含むターン。 */
export function findCopyTurns(history: CanonicalHistory): CopyTurns {
  const v2 = new Map<string, TurnCheckpointV2[]>();
  for (const turn of history.turns.values()) {
    if (turn.parts.some((p) => p.content.startsWith(REQUEST_COPY_SIGNATURE))) {
      push(v2, turn.sessionId, turn);
    }
  }
  const bySession = new Map<string, JsonlChunkRecord[]>();
  for (const record of history.legacyChunks) push(bySession, record.sessionId, record);
  const v1 = new Map<string, JsonlChunkRecord[][]>();
  for (const [sessionId, records] of bySession) {
    const turns = legacyCopyTurns(records);
    if (turns.length > 0) v1.set(sessionId, turns);
  }
  return { v2, v1, legacyIds: new Set(history.legacyChunks.map((c) => c.id)) };
}

// 1 ターンの ID は多くて数十なので、SQLite の変数の上限（32766）には届かない
const allInDb = (store: Store, ids: string[]) => store.findMissingExternalIds(ids).length === 0;

/**
 * 写しを除いた本文を、fold で採用されている revision の次として作る。書き手の索引は使わない。
 * 索引はこのマシンの書き込みしか知らず、Git で同期した記録に対して同じ revision を作ると fold が衝突する。
 * part の ID は位置で決まる。
 */
function trimmedCheckpoint(turn: TurnCheckpointV2): TurnCheckpointV2 {
  // part は partIndex の順に保存されている
  const { prompt, assistant } = stripRequestCopy(turn.parts.map((p) => p.content).join('\n\n'));
  const parts = buildCheckpointParts({
    runtime: turn.runtime,
    sessionId: turn.sessionId,
    turnKey: turn.turnKey,
    sourceOrder: turn.sourceOrder,
    observedThrough: turn.observedThrough,
    projectPath: turn.projectPath,
    completedAt: turn.completedAt,
    prompt,
    assistant,
    messages: [],
    executions: turn.executions,
  });
  const contentHash = createContentHash(
    prompt,
    assistant,
    [],
    parts,
    turn.executions,
    turn.runtime,
    turn.projectPath
  );
  return { ...turn, revision: turn.revision + 1, contentHash, parts };
}

/** DB から消えていた行（整理や --before）は戻さないので、呼び出し側は元の行が DB にあったターンだけを渡す。 */
function applyToDb(store: Store, cp: TurnCheckpointV2, deletedIds: Set<string>): void {
  const { status } = store.applyTurnCheckpoint(cp);
  const refs = store.getTurnChunkRefs(cp.sessionId, cp.turnKey);
  if (status !== 'inserted' && status !== 'already_current') {
    // DB が正本と食い違っている。写しを残さないよう、そのターンの行を消す。本文は正本にあり rebuild で戻る
    for (const row of refs) store.deleteChunk(row.id);
    return;
  }
  // 手で消した part と同じ位置の ID は、fold と同じく DB に出さない
  for (const row of refs) {
    if (row.externalId && deletedIds.has(row.externalId)) store.deleteChunk(row.id);
  }
}

function withLockedWriter(jsonlDir: string, fn: (writer: LockedJsonlWriter) => void): void {
  const writer = new JsonlTransactionWriter(jsonlDir);
  // Stryker disable BlockStatement: 閉じ忘れは接続が残るだけで、短命なプロセスの結果は変わらない
  try {
    writer.withExclusiveTransaction(fn);
  } finally {
    writer.close();
  }
  // Stryker restore BlockStatement
  return;
}

/**
 * v2 のターンを書き直す。全セッション分を 1 トランザクションで書く。
 * fold の後に、このマシンの別の書き手がより新しい revision を書いたターンは書かずに返す。次の回に読み直す。
 */
export function trimTurns(
  config: EngramConfig,
  store: Store,
  turns: TurnCheckpointV2[],
  deletedIds: Set<string>
): TurnCheckpointV2[] {
  const inDb = new Map(
    turns.map((t) => [
      t,
      allInDb(
        store,
        t.parts.map((p) => p.externalId)
      ),
    ])
  );
  const left: TurnCheckpointV2[] = [];
  const written: Array<[TurnCheckpointV2, TurnCheckpointV2]> = [];
  withLockedWriter(config.storage.jsonlDir, (w) => {
    for (const turn of turns) {
      const head = w.getTurnHead(turn.sessionId, turn.turnKey);
      if (head && head.historyEpoch === turn.historyEpoch && head.revision > turn.revision) {
        left.push(turn);
      } else {
        written.push([turn, trimmedCheckpoint(turn)]);
      }
    }
    if (written.length === 0) return;
    // 先に DB を直す。正本を書く前に止まっても、次の回は同じ checkpoint を作り直して正本に書く
    for (const [turn, cp] of written) {
      if (inDb.get(turn)) applyToDb(store, cp, deletedIds);
    }
    const now = new Date();
    const checkpoints = written.map(([, cp]) => cp);
    const serialized = serializeV2Transaction(
      checkpoints.map((cp) => ({
        v: 2 as const,
        type: 'turn_checkpoint' as const,
        // Stryker disable next-line StringLiteral: txId は serializeV2Transaction が上書きする
        txId: '',
        ...cp,
      })),
      {
        txId: hashFields(
          // Stryker disable next-line StringLiteral: 他の取引の txId と分けるための接頭辞で、値そのものは確かめようがない
          'request_copy_trim',
          ...checkpoints.flatMap((cp) => [cp.sessionId, cp.turnKey, cp.revision, cp.contentHash])
        ),
        createdAt: now.toISOString(),
        targetPath: getJsonlFilePath(config.storage.jsonlDir, now),
      }
    );
    w.applyCommittedToIndex(w.appendPrepared(serialized).transaction);
  });
  return left;
}

/** v1 の 1 ターンを書き直す計画。 */
export interface LegacyPlan {
  sessionId: string;
  ids: string[];
  chunks: Chunk[];
  inDb: boolean;
}

export function planLegacy(store: Store, records: JsonlChunkRecord[]): LegacyPlan {
  const [first] = records;
  const { prompt, assistant } = stripRequestCopy(records.map((r) => r.content).join('\n\n'));
  const text = turnToText({ human: prompt, assistant });
  const chunks: Chunk[] = (text ? splitTurnText(text, 512) : []).map((content, i) => ({
    externalId: `${first.id}${TRIMMED_ID}${i}`,
    sessionId: first.sessionId,
    projectPath: first.projectPath,
    // v1 の 1 ターンの行は連番で、写しを除いた本文は元より短いので、次のターンの番号とぶつからない
    chunkIndex: first.chunkIndex + i,
    content,
    role: detectRole(content),
    metadata: extractMetadata(content),
    tokenCount: estimateTokens(content),
    createdAt: first.createdAt,
  }));
  const ids = records.map((r) => r.id);
  return { sessionId: first.sessionId, ids, chunks, inDb: allInDb(store, ids) };
}

/**
 * v1 の行は書き換えられないので、写しを除いた本文を新しい行として足してから、元の行を消す。
 * 正本への追記と削除は、全セッション分をそれぞれ 1 回にまとめる。追記のたびに正本を読み直すため。
 */
export function applyLegacy(
  config: EngramConfig,
  store: Store,
  plans: LegacyPlan[],
  legacyIds: Set<string>
): void {
  // 先に DB を直す。正本を書く前に止まっても、次の回は同じ ID の行を作り直して正本に書く
  for (const plan of plans) {
    store.deleteChunksByExternalIds(plan.ids);
    // insertChunks はセッションの行を総入れ替えするので使わない
    if (plan.inDb) store.appendChunksWithoutReplace(plan.chunks);
  }
  // 削除より先に足す。途中で止まっても本物の発言は失われず、次の回は足した行を飛ばして削除から続ける
  const missing = plans.flatMap((p) => p.chunks).filter((c) => !legacyIds.has(c.externalId!));
  new JsonlWriter(config.storage.jsonlDir).appendRecords(chunksToJsonlRecords(missing));
  appendChunkDeletions(
    config.storage.jsonlDir,
    plans.flatMap((p) => p.ids.map((externalId) => ({ sessionId: p.sessionId, externalId })))
  );
}
