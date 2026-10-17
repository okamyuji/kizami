import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('parseArgs usage in src', () => {
  // 非 strict の parseArgs は綴りを誤ったオプションを黙って捨て、コマンドを既定値で走らせる。
  it('never disables strict mode', () => {
    const offenders = sourceFiles(path.resolve('src')).filter((file) => {
      const text = fs.readFileSync(file, 'utf-8');
      return text.includes('parseArgs') && /strict\s*:\s*false/.test(text);
    });

    expect(offenders).toEqual([]);
  });
});
