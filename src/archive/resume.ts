import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SessionLookupError } from '@/archive/resolve';
import type { ResolvedSession } from '@/archive/resolve';

export function resumeSession(
  session: ResolvedSession,
  passthrough: string[],
  opts: { projectsDir: string; spawn?: typeof spawnSync }
): number {
  const { cwd } = session;
  if (!cwd || !fs.existsSync(cwd)) {
    throw new SessionLookupError(
      `Working directory ${cwd ?? '(unknown)'} no longer exists. Use "kizami show ${session.sessionId}" to read it instead.`
    );
  }
  // claude -r は ~/.claude/projects 配下の JSONL しか読まない。消されていれば保管から戻す。
  const live = path.join(opts.projectsDir, session.dirName, `${session.sessionId}.jsonl`);
  if (!fs.existsSync(live)) {
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.copyFileSync(session.path, live);
    fs.chmodSync(live, 0o600);
  }
  const run = opts.spawn ?? spawnSync;
  const result = run('claude', ['-r', session.sessionId, ...passthrough], {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
