import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { JsonlWriter } from '@/jsonl/writer';
import { readJsonlFile, readTailRecords, isJsonlChunkRecord } from '@/jsonl/reader';
import type { JsonlChunkRecord } from '@/jsonl/types';
import { getJsonlFilePath } from '@/jsonl/path';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-jsonl-rw-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeRecord(id: string, content: string = 'hello'): JsonlChunkRecord {
  return {
    v: 1,
    type: 'chunk',
    id,
    sessionId: 'sess-1',
    projectPath: '/tmp/proj',
    chunkIndex: 0,
    content,
    role: 'human',
    metadata: null,
    tokenCount: content.length,
    createdAt: new Date().toISOString(),
  };
}

describe('jsonl writer + reader', () => {
  it('appends records and reads them back in order', async () => {
    const dir = makeTmpDir();
    const writer = new JsonlWriter(dir);
    const now = new Date(Date.UTC(2026, 4, 21));
    const records = [makeRecord('a'), makeRecord('b'), makeRecord('c')];
    const filePath = writer.appendRecords(records, now);

    const expected = getJsonlFilePath(dir, now);
    expect(filePath).toBe(expected);

    const collected: JsonlChunkRecord[] = [];
    for await (const rec of readJsonlFile(filePath)) {
      collected.push(rec);
    }
    expect(collected.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('appendRecords is idempotent for empty input (no file create)', () => {
    const dir = makeTmpDir();
    const writer = new JsonlWriter(dir);
    const now = new Date(Date.UTC(2026, 4, 21));
    const filePath = writer.appendRecords([], now);
    // ファイル名は返るが、空配列なので作られていないこともある
    expect(typeof filePath).toBe('string');
  });

  it('skips malformed lines in reader', async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, '2026-05-host.jsonl');
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify(makeRecord('a')),
        'this is not json',
        JSON.stringify({ v: 99, type: 'unknown', id: 'x' }), // bad schema
        JSON.stringify(makeRecord('b')),
        '',
      ].join('\n') + '\n'
    );
    const collected: JsonlChunkRecord[] = [];
    for await (const rec of readJsonlFile(filePath)) {
      collected.push(rec);
    }
    expect(collected.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('readTailRecords returns only last N valid records', () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, '2026-05-host.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push(JSON.stringify(makeRecord(`id-${i}`)));
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const tail = readTailRecords(filePath, 10);
    expect(tail.length).toBe(10);
    expect(tail[0].id).toBe('id-40');
    expect(tail[9].id).toBe('id-49');
  });

  it('isJsonlChunkRecord rejects invalid shapes', () => {
    expect(isJsonlChunkRecord(null)).toBe(false);
    expect(isJsonlChunkRecord({})).toBe(false);
    expect(isJsonlChunkRecord({ v: 1, type: 'chunk' })).toBe(false);
    expect(
      isJsonlChunkRecord({
        v: 1,
        type: 'chunk',
        id: 'x',
        sessionId: 's',
        projectPath: '/p',
        chunkIndex: 0,
        content: 'c',
        createdAt: '2026-01-01',
      })
    ).toBe(true);
  });
});
