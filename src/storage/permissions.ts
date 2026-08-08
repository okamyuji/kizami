import * as fs from 'node:fs';

export function enforcePrivateDirectory(directoryPath: string): void {
  const existed = fs.existsSync(directoryPath);
  if (!existed) fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });

  const stat = fs.lstatSync(directoryPath);
  if (stat.isSymbolicLink()) throw new Error(`Private storage directory cannot be a symlink`);
  if (!stat.isDirectory()) throw new Error(`Private storage path is not a directory`);
  if (process.platform === 'win32') return;
  fs.chmodSync(directoryPath, 0o700);
}

export function assertPrivateFileTarget(filePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  if (stat.isSymbolicLink()) throw new Error(`Private storage file cannot be a symlink`);
  if (!stat.isFile()) throw new Error(`Private storage path is not a file`);
}

export function enforcePrivateFile(filePath: string): void {
  assertPrivateFileTarget(filePath);
  if (process.platform === 'win32' || !fs.existsSync(filePath)) return;
  fs.chmodSync(filePath, 0o600);
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function readPrivateTextFile(filePath: string, maxBytes: number): string {
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow);
  try {
    const initial = fs.fstatSync(fd);
    const initialPath = fs.lstatSync(filePath);
    if (
      !initial.isFile() ||
      initialPath.isSymbolicLink() ||
      !sameFileIdentity(initial, initialPath) ||
      initial.size > maxBytes
    ) {
      throw new Error(`Private storage file is invalid or exceeds ${maxBytes} bytes`);
    }
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);

    const buffer = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const final = fs.fstatSync(fd);
    const finalPath = fs.lstatSync(filePath);
    if (
      offset !== buffer.length ||
      final.size !== initial.size ||
      finalPath.isSymbolicLink() ||
      !sameFileIdentity(initial, final) ||
      !sameFileIdentity(initial, finalPath)
    ) {
      throw new Error('Private storage file changed while reading');
    }
    return buffer.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}
