import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type ArchiveOutcome = 'copied' | 'current' | 'skipped';

export function getClaudeProjectsDir(): string {
  const base = process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/**
 * transcriptPath は <projects>/<dirName>/<sessionId>.jsonl を想定する。
 * 保管側は同じ <dirName> 配下に置く。resume で元の場所へそのまま書き戻せるようにするため。
 */
export function archiveTranscript(transcriptPath: string, archiveDir: string): ArchiveOutcome {
  if (!transcriptPath.endsWith('.jsonl')) return 'skipped';
  let srcMtime: number;
  try {
    srcMtime = fs.statSync(transcriptPath).mtimeMs;
  } catch {
    return 'skipped';
  }
  const dest = path.join(
    archiveDir,
    path.basename(path.dirname(transcriptPath)),
    path.basename(transcriptPath)
  );
  try {
    if (fs.statSync(dest).mtimeMs >= srcMtime) return 'current';
  } catch {
    /* 未保管 */
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 複写途中で落ちた不完全なファイルに新しい mtime が付くと、以後ずっと「最新」と
  // 誤判定される。一時ファイルに書き、元の mtime を移してから rename する。
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    // APFS では clone になり、元が残る間はディスクを消費しない。
    fs.copyFileSync(transcriptPath, tmp, fs.constants.COPYFILE_FICLONE);
    // Date だと ms 未満が落ち、保管側が常に僅かに古く見えて毎回再複写される。
    fs.utimesSync(tmp, srcMtime / 1000, srcMtime / 1000);
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
    for (const file of fs.readdirSync(dirPath, { withFileTypes: true })) {
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
