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
  // Stryker disable next-line all: ENOENT catchにより変異しても観測可能な挙動が変わらない
  if (process.platform === 'win32' || !fs.existsSync(filePath)) return;
  // chmodSyncはsymlinkを辿るため、O_NOFOLLOW fdへのfchmodで差し替え競合を防ぐ
  let fd: number;
  // Stryker disable all: existsSyncとopenの間の消失raceは決定的に再現できない
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // Stryker restore all
  try {
    // Stryker disable next-line all: assertPrivateFileTarget通過後の差し替えraceは決定的に再現できない
    if (!fs.fstatSync(fd).isFile()) throw new Error('Private storage path is not a file');
    fs.fchmodSync(fd, 0o600);
    // Stryker disable next-line all: fd leakはプロセス外部観測が必要でユニットテスト不能
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * SQLite のファイルの権限を、fd を開かずに絞る。POSIX のロックはプロセス単位で、同じファイルの fd を
 * どれか 1 つ閉じると、同じプロセスの SQLite の接続が持つロックまで外れる。外れると、別のプロセスが
 * 自分を最後の接続とみなして -shm と WAL を消し、開いている接続の読み込みが壊れる。
 * パスでの chmod はリンクを辿るが、親ディレクトリは enforcePrivateDirectory で所有者だけのものにしてある。
 */
export function restrictSqliteFile(filePath: string): void {
  assertPrivateFileTarget(filePath);
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error: unknown) {
    // 確かめた後に、別のプロセスが最後の接続として -shm や WAL を消すことがある
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
