/** Verified recovery copy and no-replace rename; used only by the one-time switch script. */
import { dlopen, FFIType, ptr, suffix } from 'bun:ffi';
import { chmod, lstat, mkdir, open, readdir, readlink, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface Entry {
  readonly path: string;
  readonly type: string;
  readonly size: number;
  readonly mode: number;
  readonly sha256?: string;
  readonly link?: string;
}

/** Never follows a symlink; hashes are streamed and values are never printed. Special files are metadata only. */
export async function manifest(root: string): Promise<readonly Entry[]> {
  const entries: Entry[] = [];
  async function walk(relative: string): Promise<void> {
    const path = join(root, relative);
    const info = await lstat(path);
    const mode = info.mode & 0o7777;
    if (info.isDirectory()) {
      entries.push({ path: relative, type: 'directory', size: 0, mode });
      for (const name of (await readdir(path)).sort()) await walk(join(relative, name));
    } else if (info.isFile()) {
      const hash = new Bun.CryptoHasher('sha256');
      const file = await open(path, 'r');
      try {
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      } finally {
        await file.close();
      }
      entries.push({ path: relative, type: 'file', size: info.size, mode, sha256: hash.digest('hex') });
    } else if (info.isSymbolicLink())
      entries.push({ path: relative, type: 'link', size: 0, mode, link: await readlink(path) });
    else if (info.isSocket()) entries.push({ path: relative, type: 'socket', size: 0, mode });
    else throw new Error('home contains an unsupported special file; nothing was moved');
  }
  await walk('');
  return entries;
}

export function verifyManifests(source: readonly Entry[], copied: readonly Entry[]): void {
  if (JSON.stringify(source) !== JSON.stringify(copied))
    throw new Error(
      'recovery copy verification failed (file count, modes, sizes or content hashes); nothing was moved',
    );
}

/** Kernel no-replace rename: neither a file nor a directory planted at the target can be overwritten or nested. */
export function moveNoReplace(from: string, to: string): void {
  renamePaths(from, to, false);
}

/** Atomically exchange a blocking placeholder with an already locked new home: there is no absent-home window. */
export function exchangePaths(from: string, to: string): void {
  renamePaths(from, to, true);
}

function renamePaths(from: string, to: string, exchange: boolean): void {
  const source = Buffer.from(`${from}\0`),
    target = Buffer.from(`${to}\0`);
  let result: number;
  if (process.platform === 'darwin') {
    const lib = dlopen('libSystem.B.dylib', {
      renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    try {
      result = lib.symbols.renamex_np(ptr(source), ptr(target), exchange ? 2 : 4);
    } finally {
      // RENAME_EXCL
      lib.close();
    }
  } else {
    const lib = dlopen(`libc.${suffix}.6`, {
      renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    try {
      result = lib.symbols.renameat2(-100, ptr(source), -100, ptr(target), exchange ? 2 : 1);
    } finally {
      // RENAME_NOREPLACE
      lib.close();
    }
  }
  if (result !== 0)
    throw new Error(
      exchange
        ? 'cannot exchange the cutover placeholder and locked new home'
        : 'cannot move home without replacing a destination; nothing was moved',
    );
}

export async function recoveryCopy(
  from: string,
  to: string,
  space: (path: string) => Promise<{ readonly bsize: number; readonly bavail: number }> = statfs,
): Promise<void> {
  if (
    await lstat(to).then(
      () => true,
      error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    )
  )
    throw new Error('recovery destination already exists; nothing was moved');
  const before = await manifest(from);
  const disk = await space(dirname(to));
  const bytes = before.reduce(
    (sum, entry) => sum + (entry.type === 'file' ? Math.ceil(entry.size / disk.bsize) * disk.bsize : disk.bsize),
    0,
  );
  if (disk.bavail * disk.bsize < bytes + 16 * 1024 * 1024)
    throw new Error('not enough disk space for the recovery copy; free space and retry. Nothing was moved');
  // cp -a preserves opaque data, hard links, symlinks, modes and socket entries without opening them as files.
  const staging = `${to}.partial`;
  await mkdir(staging, { mode: 0o700 });
  const copied = join(staging, 'home');
  const copy = Bun.spawn(['cp', '-a', from, copied], { stdout: 'ignore', stderr: 'ignore' });
  if ((await copy.exited) !== 0) throw new Error('recovery copy failed; nothing was moved (the partial copy was kept)');
  verifyManifests(before, await manifest(copied));
  verifyManifests(before, await manifest(from));
  await writeFile(`${to}.manifest.json`, `${JSON.stringify(before, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(copied, 0o700);
  moveNoReplace(copied, to);
}

if (import.meta.main) {
  const [command, from, to] = process.argv.slice(2);
  try {
    if (from === undefined || to === undefined) throw new Error('missing recovery paths');
    if (command === 'copy') await recoveryCopy(from, to);
    else if (command === 'move') moveNoReplace(from, to);
    else throw new Error('unknown recovery command');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'recovery operation failed; nothing was moved');
    process.exitCode = 1;
  }
}
