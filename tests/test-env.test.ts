import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultTranscriptArchiveDir, getDefaultConfig } from '../src/config';
import { getClaudeProjectsDir } from '../src/archive/store';

// A mutant or a test that drops one override falls back to these defaults, so they must not
// point at the real home directory either.
describe('test environment', () => {
  it('points every default data location at the temp directory', () => {
    const tmp = path.resolve(os.tmpdir());
    const d = getDefaultConfig();
    for (const p of [
      getDefaultTranscriptArchiveDir(),
      getClaudeProjectsDir(),
      d.database.path,
      d.storage.jsonlDir,
    ]) {
      expect(path.resolve(p).startsWith(tmp + path.sep)).toBe(true);
    }
  });
});
