import * as fs from 'node:fs';
import * as path from 'node:path';

export const BEGIN_MARKER = '# BEGIN kizami-managed';
export const END_MARKER = '# END kizami-managed';

export interface TomlHook {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

export function formatKizamiTomlBlock(hooks: TomlHook[]): string {
  const lines: string[] = [BEGIN_MARKER];
  for (const hook of hooks) {
    lines.push('[[hooks]]');
    lines.push(`event = "${hook.event}"`);
    if (hook.matcher != null) {
      lines.push(`matcher = "${hook.matcher}"`);
    }
    lines.push(`command = "${hook.command}"`);
    if (hook.timeout != null) {
      lines.push(`timeout = ${hook.timeout}`);
    }
    lines.push('');
  }
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  lines.push(END_MARKER);
  return lines.join('\n');
}

export function hasKizamiTomlBlock(content: string): boolean {
  return content.includes(BEGIN_MARKER);
}

export function removeKizamiTomlBlock(content: string): string {
  const beginIdx = content.indexOf(BEGIN_MARKER);
  if (beginIdx === -1) return content;

  const endIdx = content.indexOf(END_MARKER, beginIdx);
  if (endIdx === -1) return content;

  const endLineEnd = content.indexOf('\n', endIdx);
  const removeEnd = endLineEnd === -1 ? content.length : endLineEnd + 1;

  let removeStart = beginIdx;
  if (removeStart > 0 && content[removeStart - 1] === '\n') {
    removeStart--;
    if (removeStart > 0 && content[removeStart - 1] === '\r') {
      removeStart--;
    }
  }

  const before = content.slice(0, removeStart);
  const after = content.slice(removeEnd);

  const result = before + after;
  return result.replace(/\n{3,}/g, '\n\n');
}

export function countKizamiTomlHooks(content: string): number {
  const beginIdx = content.indexOf(BEGIN_MARKER);
  if (beginIdx === -1) return 0;

  const endIdx = content.indexOf(END_MARKER, beginIdx);
  if (endIdx === -1) return 0;

  const block = content.slice(beginIdx, endIdx);
  const matches = block.match(/\[\[hooks\]\]/g);
  return matches ? matches.length : 0;
}

function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let mode = 0o644;
  try {
    mode = fs.statSync(filePath).mode;
  } catch {
    /* file does not exist */
  }

  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode });
  fs.renameSync(tmpPath, filePath);
}

export function writeKizamiTomlHooks(filePath: string, hooks: TomlHook[]): void {
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch {
    /* file does not exist */
  }

  const cleaned = removeKizamiTomlBlock(existing);
  const block = formatKizamiTomlBlock(hooks);
  const separator =
    cleaned.length > 0 && !cleaned.endsWith('\n') ? '\n\n' : cleaned.length > 0 ? '\n' : '';
  const content = cleaned + separator + block + '\n';

  atomicWriteFile(filePath, content);
}

export function removeKizamiTomlHooksFromFile(filePath: string): void {
  let existing: string;
  try {
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }

  if (!hasKizamiTomlBlock(existing)) return;

  const cleaned = removeKizamiTomlBlock(existing);
  atomicWriteFile(filePath, cleaned);
}
