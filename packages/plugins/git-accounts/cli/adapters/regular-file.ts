import { lstat, stat } from 'node:fs/promises';

/**
 * Whether `path` is a regular file (a symbolic link counts when what it points at is one), decided WITHOUT opening it.
 *
 * Opening a FIFO for reading blocks until something opens the other end, so `fy gh` asks this before it reads a
 * `.git` file or a `HEAD`: a ferret can make either one a FIFO in its own folder, and a read would then hang the
 * verb for good. A name that is not there, a folder, a device, a socket or a link to any of them answers `false`.
 */
export async function isRegularFile(path: string): Promise<boolean> {
  try {
    const own = await lstat(path);
    if (own.isFile()) return true;
    // A link is followed, still without opening: `stat` never opens its target.
    return own.isSymbolicLink() && (await stat(path)).isFile();
  } catch {
    return false;
  }
}
