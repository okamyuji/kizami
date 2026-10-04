import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

export type ArchiveOutcome = 'copied' | 'current' | 'skipped';

export function getClaudeProjectsDir(): string {
  const base = process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/**
 * macOS では Node の COPYFILE_FICLONE が実際には複製せず、容量を丸ごと消費する (実測)。
 * `cp -c` (clonefile) なら元が残る間は追加容量を使わない。
 */
export function copyPreferClone(
  src: string,
  dst: string,
  platform: NodeJS.Platform = process.platform,
  exec: (file: string, args: string[]) => unknown = execFileSync
): void {
  if (platform === 'darwin') {
    try {
      exec('/bin/cp', ['-c', src, dst]);
      return;
    } catch {
      /* clone 不可 (別ボリューム等) は通常複写へ */
    }
  }
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
}

/**
 * transcriptPath は <projects>/<dirName>/<sessionId>.jsonl を想定する。
 * 保管側は同じ <dirName> 配下に置く。resume で元の場所へそのまま書き戻せるようにするため。
 */
export function archiveTranscript(transcriptPath: string, archiveDir: string): ArchiveOutcome {
  if (!transcriptPath.endsWith('.jsonl')) return 'skipped';
  let srcStat: fs.Stats;
  try {
    srcStat = fs.statSync(transcriptPath);
  } catch {
    return 'skipped';
  }
  const dest = path.join(
    archiveDir,
    path.basename(path.dirname(transcriptPath)),
    path.basename(transcriptPath)
  );
  try {
    // utimes 経由の往復で ms 未満が丸まるため、mtime は ms で比べ、size も併せて見る。
    const d = fs.statSync(dest);
    if (Math.floor(d.mtimeMs) >= Math.floor(srcStat.mtimeMs) && d.size === srcStat.size) {
      return 'current';
    }
  } catch {
    /* 未保管 */
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 複写途中で落ちた不完全なファイルに新しい mtime が付くと、以後ずっと「最新」と
  // 誤判定される。一時ファイルに書き、元の mtime を移してから rename する。
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    copyPreferClone(transcriptPath, tmp);
    fs.utimesSync(tmp, srcStat.mtimeMs / 1000, srcStat.mtimeMs / 1000);
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return 'copied';
}

export function archiveAll(
  projectsDir: string,
  archiveDir: string
): { copied: number; current: number; failed: number } {
  const counts = { copied: 0, current: 0, failed: 0 };
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return counts;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(projectsDir, dir.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      counts.failed++;
      process.stderr.write(`kizami archive: ${dir.name}: ${String(err)}\n`);
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      try {
        const outcome = archiveTranscript(path.join(dirPath, file.name), archiveDir);
        if (outcome === 'copied') counts.copied++;
        else if (outcome === 'current') counts.current++;
      } catch (err) {
        counts.failed++;
        process.stderr.write(`kizami archive: ${file.name}: ${String(err)}\n`);
      }
    }
  }
  return counts;
}
