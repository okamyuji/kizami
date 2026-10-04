import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSession, SessionLookupError } from '../../src/archive/resolve';

const line = (o: object) => JSON.stringify(o) + '\n';

describe('resolveSession', () => {
  let tmp: string;
  let archiveDir: string;
  let projectsDir: string;
  const roots = () => ({ archiveDir, projectsDir });

  function put(root: string, dir: string, id: string, body: string) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, `${id}.jsonl`), body);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizami-resolve-'));
    archiveDir = path.join(tmp, 'archive');
    projectsDir = path.join(tmp, 'projects');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('resolves a unique prefix and reads cwd and gitBranch from the first line that has them', async () => {
    put(
      projectsDir,
      '-p',
      'abcdef01-1111',
      line({ type: 'summary' }) + line({ cwd: '/w/p', gitBranch: 'main' })
    );
    const s = await resolveSession('abcdef', roots());
    expect(s).toEqual({
      sessionId: 'abcdef01-1111',
      path: path.join(projectsDir, '-p', 'abcdef01-1111.jsonl'),
      dirName: '-p',
      cwd: '/w/p',
      gitBranch: 'main',
    });
  });

  it('prefers the archived copy when both exist', async () => {
    put(projectsDir, '-p', 'abcdef01-1111', line({ cwd: '/live' }));
    put(archiveDir, '-p', 'abcdef01-1111', line({ cwd: '/archived' }));
    const s = await resolveSession('abcdef01', roots());
    expect(s.path).toBe(path.join(archiveDir, '-p', 'abcdef01-1111.jsonl'));
  });

  it('finds sessions that exist only in the archive', async () => {
    put(archiveDir, '-p', 'abcdef01-1111', line({ cwd: '/w' }));
    expect((await resolveSession('abcd', roots())).sessionId).toBe('abcdef01-1111');
  });

  it('throws with candidates when the prefix is ambiguous', async () => {
    put(projectsDir, '-p', 'abcd0001', line({}));
    put(projectsDir, '-q', 'abcd0002', line({}));
    await expect(resolveSession('abcd', roots())).rejects.toThrow(
      'Session id "abcd" is ambiguous:'
    );
    await expect(resolveSession('abcd', roots())).rejects.toThrow('\n  abcd0001  -p');
    await expect(resolveSession('abcd', roots())).rejects.toThrow('\n  abcd0002  -q');
    await expect(resolveSession('abcd', roots())).rejects.toBeInstanceOf(SessionLookupError);
  });

  it('throws when nothing matches', async () => {
    await expect(resolveSession('ffff', roots())).rejects.toThrow(/No session matches "ffff"/);
  });

  it.each(['../x', 'abc', 'ab/cd', '', 'xyz-abcd', 'abcd-xyz'])(
    'rejects invalid id %j',
    async (bad) => {
      await expect(resolveSession(bad, roots())).rejects.toThrow(/Invalid session id/);
    }
  );

  it('leaves cwd undefined when no line has it', async () => {
    put(projectsDir, '-p', 'abcd0001', line({ type: 'summary' }) + 'not json\n');
    expect((await resolveSession('abcd0001', roots())).cwd).toBeUndefined();
  });

  it('ignores stray files at the root and non-jsonl files in project dirs', async () => {
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, 'abcd0009.jsonl'), '');
    put(projectsDir, '-p', 'abcd0001', line({ cwd: '/w' }));
    fs.writeFileSync(path.join(projectsDir, '-p', 'abcd0002.txt'), '');
    expect((await resolveSession('abcd', roots())).sessionId).toBe('abcd0001');
  });

  it('skips unparsable, null and primitive lines before the cwd line', async () => {
    put(
      projectsDir,
      '-p',
      'abcd0001',
      'not json\nnull\n5\n"str"\n' + line({ cwd: '/w', gitBranch: 'dev' })
    );
    const s = await resolveSession('abcd0001', roots());
    expect([s.cwd, s.gitBranch]).toEqual(['/w', 'dev']);
  });

  it('ignores a non-string gitBranch and reads multibyte cwd', async () => {
    put(projectsDir, '-p', 'abcd0001', line({ cwd: '/作業', gitBranch: 5 }));
    const s = await resolveSession('abcd0001', roots());
    expect(s.cwd).toBe('/作業');
    expect(s.gitBranch).toBeUndefined();
  });

  it('ignores a line whose cwd is not a string', async () => {
    put(projectsDir, '-p', 'abcd0001', line({ cwd: 5 }) + line({ cwd: '/ok' }));
    expect((await resolveSession('abcd0001', roots())).cwd).toBe('/ok');
  });

  it('reports one candidate per id when both roots hold the same session', async () => {
    put(projectsDir, '-p', 'abcd0001', line({}));
    put(archiveDir, '-p', 'abcd0001', line({}));
    expect((await resolveSession('abcd', roots())).sessionId).toBe('abcd0001');
  });
});
