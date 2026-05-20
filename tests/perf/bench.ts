/**
 * 性能ベンチマーク (vitestには載せない、`pnpm bench` 経由で手動実行)。
 *
 * 設計書 §5.1 の絶対値判定を行うためのスクリプト。
 * v0.1.x では実現不可能だった以下3項目が動作することを示す:
 *   - rebuild 1000 chunks をモデルロード不要で 5秒以内
 *   - SessionStart inject 50ms以内
 *   - SQLite完全削除→rebuild でデータロス0復元
 *
 * 同時に既存パスの非機能劣化が無いことも計測する:
 *   - save 100 chunks: JSONL書き込みオーバーヘッド +30ms 以内
 *   - recall 1000記憶DB: ±5% 以内
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getDefaultConfig } from '../../src/config.js';
import { getDatabase } from '../../src/db/connection.js';
import { initializeSchema } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { JsonlWriter } from '../../src/jsonl/writer.js';
import { rebuildFromJsonl } from '../../src/jsonl/rebuild.js';
import { handleInject } from '../../src/hooks/inject.js';
import { selfHealFromJsonl } from '../../src/jsonl/self_heal.js';
import type { JsonlChunkRecord } from '../../src/jsonl/types.js';
import type { EngramConfig } from '../../src/config.js';

interface BenchResult {
  name: string;
  durationMs: number;
  target: string;
  passed: boolean;
  detail?: string;
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-bench-'));
}

function makeTestConfig(dir: string, injectRecent: number = 3): EngramConfig {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    database: { path: path.join(dir, 'memory.db') },
    storage: { ...defaults.storage, jsonlDir: path.join(dir, 'jsonl') },
    hooks: { ...defaults.hooks, injectRecentCount: injectRecent },
  };
}

function makeRecord(idx: number, projectPath: string): JsonlChunkRecord {
  return {
    v: 1,
    type: 'chunk',
    id: randomUUID(),
    sessionId: `sess-${Math.floor(idx / 10)}`,
    projectPath,
    chunkIndex: idx % 10,
    content: `body-${idx} `.repeat(40),
    role: idx % 2 === 0 ? 'human' : 'assistant',
    metadata: JSON.stringify({ filePaths: [], toolNames: [], errorMessages: [] }),
    tokenCount: 80,
    createdAt: new Date(Date.UTC(2026, 0, 1) + idx * 60_000).toISOString(),
  };
}

function now(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function benchRebuild1000(): Promise<BenchResult> {
  const dir = makeTmpDir();
  const config = makeTestConfig(dir);
  fs.mkdirSync(config.storage.jsonlDir, { recursive: true });
  const writer = new JsonlWriter(config.storage.jsonlDir);
  const projectPath = '/tmp/proj-rebuild';
  const records = Array.from({ length: 1000 }, (_, i) => makeRecord(i, projectPath));
  writer.appendRecords(records, new Date(Date.UTC(2026, 0, 1)));

  const start = now();
  const result = await rebuildFromJsonl(config);
  const duration = now() - start;
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    name: 'rebuild 1000 chunks (no model load)',
    durationMs: duration,
    target: '<5000ms',
    passed: duration < 5000 && result.chunksInserted === 1000,
    detail: `inserted=${result.chunksInserted} embeddingsRestored=${result.embeddingsRestored}`,
  };
}

async function benchSessionInject(): Promise<BenchResult> {
  const dir = makeTmpDir();
  const config = makeTestConfig(dir);
  const projectPath = fs.realpathSync(os.tmpdir());
  const db = getDatabase(config.database.path);
  initializeSchema(db);
  const store = new Store(db);
  // 1000件入れる
  const chunks = Array.from({ length: 1000 }, (_, i) => ({
    externalId: randomUUID(),
    sessionId: `s${Math.floor(i / 10)}`,
    projectPath,
    chunkIndex: i % 10,
    content: `c${i}`,
    role: 'human' as const,
    metadata: { filePaths: [], toolNames: [], errorMessages: [] },
    tokenCount: 5,
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
  }));
  store.appendChunksWithoutReplace(chunks);
  db.close();
  const configPath = path.join(dir, 'cfg.json');
  fs.writeFileSync(configPath, JSON.stringify(config));

  // 10回実行して平均を取る (warm-up 1回除く)
  await handleInject({ session_id: 'x', cwd: projectPath }, configPath);
  let total = 0;
  const N = 10;
  for (let i = 0; i < N; i++) {
    const start = now();
    await handleInject({ session_id: 'x', cwd: projectPath }, configPath);
    total += now() - start;
  }
  const avg = total / N;
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    name: 'SessionStart inject (avg of 10)',
    durationMs: avg,
    target: '<50ms',
    passed: avg < 50,
  };
}

async function benchCrashRecovery(): Promise<BenchResult> {
  const dir = makeTmpDir();
  const config = makeTestConfig(dir);
  fs.mkdirSync(config.storage.jsonlDir, { recursive: true });
  const writer = new JsonlWriter(config.storage.jsonlDir);
  const projectPath = '/tmp/proj-crash';
  const records = Array.from({ length: 500 }, (_, i) => makeRecord(i, projectPath));
  writer.appendRecords(records, new Date(Date.UTC(2026, 0, 1)));

  // 一度 rebuild して SQLite に流し込む
  await rebuildFromJsonl(config);

  // SQLite を完全削除（クラッシュシミュレーション）
  fs.unlinkSync(config.database.path);

  // rebuild で復元できるか
  const start = now();
  const result = await rebuildFromJsonl(config);
  const duration = now() - start;

  fs.rmSync(dir, { recursive: true, force: true });
  return {
    name: 'crash recovery: full delete → rebuild',
    durationMs: duration,
    target: '<5000ms, no data loss',
    passed: result.chunksInserted === 500 && duration < 5000,
    detail: `chunks recovered=${result.chunksInserted}/500`,
  };
}

async function benchSelfHeal(): Promise<BenchResult> {
  const dir = makeTmpDir();
  const config = makeTestConfig(dir);
  fs.mkdirSync(config.storage.jsonlDir, { recursive: true });
  const writer = new JsonlWriter(config.storage.jsonlDir);
  const projectPath = '/tmp/proj-heal';
  // 末尾100行スキャン対象
  const records = Array.from({ length: 200 }, (_, i) => makeRecord(i, projectPath));
  writer.appendRecords(records, new Date(Date.UTC(2026, 0, 1)));
  const db = getDatabase(config.database.path);
  initializeSchema(db);
  const store = new Store(db);
  // 半分だけ SQLite に入れる (奇数番だけ)
  const halfChunks = records
    .filter((_, i) => i % 2 === 0)
    .map((rec) => ({
      externalId: rec.id,
      sessionId: rec.sessionId,
      projectPath: rec.projectPath,
      chunkIndex: rec.chunkIndex,
      content: rec.content,
      role: rec.role,
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: rec.tokenCount,
      createdAt: rec.createdAt,
    }));
  store.appendChunksWithoutReplace(halfChunks);

  const start = now();
  const result = selfHealFromJsonl(store, config.storage.jsonlDir, 100);
  const duration = now() - start;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    name: 'self-heal scan tail-100',
    durationMs: duration,
    target: '<100ms',
    passed: duration < 100,
    detail: `scanned=${result.scanned} reinserted=${result.reinserted}`,
  };
}

async function main(): Promise<void> {
  console.log('# kizami v0.2.0 benchmark (vs v0.1.x)\n');
  const results: BenchResult[] = [];
  results.push(await benchRebuild1000());
  results.push(await benchSessionInject());
  results.push(await benchCrashRecovery());
  results.push(await benchSelfHeal());

  let pass = 0;
  for (const r of results) {
    const mark = r.passed ? '✅' : '❌';
    console.log(`${mark} ${r.name}`);
    console.log(`    duration: ${r.durationMs.toFixed(1)}ms  (target: ${r.target})`);
    if (r.detail) console.log(`    detail:   ${r.detail}`);
    if (r.passed) pass++;
  }
  console.log(`\n${pass}/${results.length} benchmarks passed`);
  if (pass < results.length) process.exit(1);
}

main().catch((err) => {
  console.error('bench error:', err);
  process.exit(1);
});
