import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { getDatabase } from '../../src/db/connection';
import { initializeSchema } from '../../src/db/schema';
import { Store } from '../../src/db/store';
import type { Chunk } from '../../src/db/store';
import {
  mergeChunks,
  extractTrigrams,
  jaccardSimilarity,
  informationScore,
} from '../../src/maintenance/merge';
import type Database from 'better-sqlite3';

describe('extractTrigrams', () => {
  it('should extract trigrams from text', () => {
    const trigrams = extractTrigrams('hello');
    expect(trigrams.has('hel')).toBe(true);
    expect(trigrams.has('ell')).toBe(true);
    expect(trigrams.has('llo')).toBe(true);
    expect(trigrams.size).toBe(3);
  });

  it('should handle Japanese text', () => {
    const trigrams = extractTrigrams('日本語テスト');
    expect(trigrams.has('日本語')).toBe(true);
    expect(trigrams.has('本語テ')).toBe(true);
    expect(trigrams.size).toBe(4);
  });
});

describe('jaccardSimilarity', () => {
  it('should return 1 for identical sets', () => {
    const a = new Set(['abc', 'bcd', 'cde']);
    expect(jaccardSimilarity(a, a)).toBe(1);
  });

  it('should return 0 for disjoint sets', () => {
    const a = new Set(['abc', 'bcd']);
    const b = new Set(['xyz', 'yz1']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('should return expected value for overlapping sets', () => {
    const a = new Set(['abc', 'bcd', 'cde']);
    const b = new Set(['abc', 'bcd', 'xyz']);
    // intersection = 2, union = 4
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
  });
});

describe('informationScore', () => {
  it('should give higher score to longer content', () => {
    const short: Chunk = {
      sessionId: 's1',
      projectPath: '/p',
      chunkIndex: 0,
      content: 'short',
      role: 'human',
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: 1,
    };
    const long: Chunk = {
      ...short,
      content: 'a'.repeat(1000),
    };
    expect(informationScore(long)).toBeGreaterThan(informationScore(short));
  });

  it('should give higher score to chunks with rich metadata', () => {
    const bare: Chunk = {
      sessionId: 's1',
      projectPath: '/p',
      chunkIndex: 0,
      content: 'test content',
      role: 'human',
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: 3,
    };
    const rich: Chunk = {
      ...bare,
      metadata: {
        filePaths: ['a.ts', 'b.ts', 'c.ts'],
        toolNames: ['Edit', 'Bash'],
        errorMessages: [],
      },
    };
    expect(informationScore(rich)).toBeGreaterThan(informationScore(bare));
  });
});

describe('mergeChunks', () => {
  let db: Database.Database;
  let store: Store;
  let tmpDir: string;

  function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
    return {
      sessionId: 'session-1',
      projectPath: '/test/project',
      chunkIndex: 0,
      content: 'Base content for testing purposes',
      role: 'mixed',
      metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      tokenCount: 10,
      ...overrides,
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-merge-'));
    db = getDatabase(path.join(tmpDir, 'test.db'));
    initializeSchema(db);
    store = new Store(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should merge very similar chunks within same session', () => {
    store.insertChunks([
      makeChunk({
        chunkIndex: 0,
        content:
          'React Hook FormでuseStateを使ってフォームバリデーションを実装しています。入力値の管理にはuseStateを使用します。',
      }),
      makeChunk({
        chunkIndex: 1,
        content:
          'React Hook FormでuseStateを使ってフォームバリデーションを実装しました。入力値の管理にはuseStateを使用しています。',
      }),
    ]);

    const result = mergeChunks(db, { similarityThreshold: 0.5 });
    expect(result.groupsFound).toBe(1);
    expect(result.chunksRemoved).toBe(1);

    // 1つだけ残っていることを確認
    const remaining = db.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
      count: number;
    };
    expect(remaining.count).toBe(1);
  });

  it('should not merge dissimilar chunks', () => {
    store.insertChunks([
      makeChunk({
        chunkIndex: 0,
        content: 'React Hook Formでフォームバリデーションを実装しています。',
      }),
      makeChunk({
        chunkIndex: 1,
        content: 'Pythonでデータ分析パイプラインを構築しました。pandasとnumpyを使用。',
      }),
    ]);

    const result = mergeChunks(db, { similarityThreshold: 0.6 });
    expect(result.groupsFound).toBe(0);
    expect(result.chunksRemoved).toBe(0);
  });

  it('should not merge chunks from different sessions', () => {
    store.insertChunks([
      makeChunk({
        sessionId: 'session-1',
        chunkIndex: 0,
        content: 'React Hook FormでuseStateを使ってフォームバリデーションを実装しています。',
      }),
    ]);
    store.insertChunks([
      makeChunk({
        sessionId: 'session-2',
        chunkIndex: 0,
        content: 'React Hook FormでuseStateを使ってフォームバリデーションを実装しています。',
      }),
    ]);

    const result = mergeChunks(db, { similarityThreshold: 0.5 });
    expect(result.groupsFound).toBe(0);
  });

  it('should keep the chunk with higher information score', () => {
    // 同じセッション内で、ほぼ同じ内容だが片方がより詳細
    const baseContent =
      'React Hook Formでフォームバリデーションを実装しました。useStateで入力値を管理しバリデーションルールを定義しています。';
    store.insertChunks([
      makeChunk({
        chunkIndex: 0,
        content: baseContent,
        role: 'human',
        metadata: { filePaths: [], toolNames: [], errorMessages: [] },
      }),
      makeChunk({
        chunkIndex: 1,
        content:
          baseContent +
          ' src/Form.tsxを編集してフォームコンポーネントを作成しました。テストも追加しています。',
        role: 'mixed',
        metadata: {
          filePaths: ['src/Form.tsx'],
          toolNames: ['Edit'],
          errorMessages: [],
        },
      }),
    ]);

    const result = mergeChunks(db, { similarityThreshold: 0.4 });
    expect(result.chunksRemoved).toBe(1);

    // 情報量の多い方(chunkIndex=1)が残っているはず
    const remaining = db.prepare('SELECT content FROM chunks').get() as { content: string };
    expect(remaining.content).toContain('src/Form.tsx');
  });

  it('should support dry-run mode', () => {
    store.insertChunks([
      makeChunk({
        chunkIndex: 0,
        content:
          'React Hook FormでuseStateを使ってフォームバリデーションを実装しています。入力値の管理。',
      }),
      makeChunk({
        chunkIndex: 1,
        content:
          'React Hook FormでuseStateを使ってフォームバリデーションを実装しました。入力値の管理。',
      }),
    ]);

    const result = mergeChunks(db, { similarityThreshold: 0.5, dryRun: true });
    expect(result.groupsFound).toBe(1);
    expect(result.chunksRemoved).toBe(1);

    // dry-runなので実際には削除されていない
    const remaining = db.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
      count: number;
    };
    expect(remaining.count).toBe(2);
  });
});
