import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readLines } from '@/storage/lines';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function write(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-lines-'));
  dirs.push(dir);
  const file = path.join(dir, 'f.jsonl');
  fs.writeFileSync(file, content);
  return file;
}

async function collect(file: string): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(file)) out.push(line);
  return out;
}

describe('readLines', () => {
  it('splits on \\n only, keeps U+2028, U+2029 and a trailing \\r', async () => {
    const file = write('a b c\r\nd\ne');
    expect(await collect(file)).toEqual(['a b c\r', 'd', 'e']);
  });

  it('ends with an empty string after a final newline and for an empty file', async () => {
    expect(await collect(write('a\n'))).toEqual(['a', '']);
    expect(await collect(write(''))).toEqual(['']);
    expect(await collect(write('\n\n'))).toEqual(['', '', '']);
  });

  it('joins lines that span stream chunks without breaking multi-byte characters', async () => {
    const wide = '€'.repeat(100_000);
    const file = write(`${wide}\nx${wide}\n${wide}y`);
    expect(await collect(file)).toEqual([wide, `x${wide}`, `${wide}y`]);
  });

  it('keeps a chunk that holds several newlines and the tail of the next line', async () => {
    const lines = Array.from({ length: 30_000 }, (_, i) => `line-${i}`);
    expect(await collect(write(lines.join('\n')))).toEqual(lines);
  });

  it('stops reading when the caller breaks out', async () => {
    const file = write('a\nb\nc\n');
    const seen: string[] = [];
    for await (const line of readLines(file)) {
      seen.push(line);
      break;
    }
    expect(seen).toEqual(['a']);
  });

  it('reads a long line without a newline in linear time', async () => {
    const file = write('x'.repeat(32 * 1024 * 1024));
    const start = Date.now();
    const lines = await collect(file);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(32 * 1024 * 1024);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
