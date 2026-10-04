import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export class SessionLookupError extends Error {}

export interface ResolvedSession {
  sessionId: string;
  path: string;
  dirName: string;
  cwd?: string;
  gitBranch?: string;
}

// ID はファイル名に直結するので、区切り文字や .. を通さない。
const SESSION_ID_RE = /^[0-9a-f-]{4,}$/i;

function collect(
  root: string,
  prefix: string,
  found: Map<string, { path: string; dirName: string }>
) {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(root, dir.name))) {
      if (!name.startsWith(prefix) || !name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!found.has(id))
        found.set(id, { path: path.join(root, dir.name, name), dirName: dir.name });
    }
  }
}

type Header = { cwd?: unknown; gitBranch?: unknown } | null;

// Stryker disable BlockStatement: catch の中身を空にしても undefined が返り、呼び出し側の ?. が同じく読み飛ばすため区別できない
function parseLine(raw: string): Header | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
// Stryker restore BlockStatement

async function readHeader(file: string): Promise<{ cwd?: string; gitBranch?: string }> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  // return / break で for await を抜けると readline は自動で閉じる
  for await (const raw of rl) {
    const obj = parseLine(raw);
    if (typeof obj?.cwd === 'string') {
      const { cwd, gitBranch } = obj;
      return { cwd, gitBranch: typeof gitBranch === 'string' ? gitBranch : undefined };
    }
  }
  return {};
}

export async function resolveSession(
  prefix: string,
  roots: { archiveDir: string; projectsDir: string }
): Promise<ResolvedSession> {
  if (!SESSION_ID_RE.test(prefix)) {
    throw new SessionLookupError(`Invalid session id "${prefix}". Use at least 4 hex characters.`);
  }
  const found = new Map<string, { path: string; dirName: string }>();
  collect(roots.archiveDir, prefix, found);
  collect(roots.projectsDir, prefix, found);
  if (found.size === 0) throw new SessionLookupError(`No session matches "${prefix}".`);
  if (found.size > 1) {
    const list = [...found.entries()].map(([id, f]) => `  ${id}  ${f.dirName}`).join('\n');
    throw new SessionLookupError(`Session id "${prefix}" is ambiguous:\n${list}`);
  }
  const [[sessionId, hit]] = [...found.entries()];
  return { sessionId, ...hit, ...(await readHeader(hit.path)) };
}
