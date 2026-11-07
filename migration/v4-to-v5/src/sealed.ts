/**
 * Moving sealed and secret files: byte for byte, never opened.
 *
 * The rule (owner, 2026-11-07; spine D16): no agent and no script ever opens a secret value. A sealed file is moved
 * with the kernel's own copy call (`copyFile`, which hands the bytes from one descriptor to another without them ever
 * becoming a JavaScript value), then given the source's mode and times — the same thing as `cp --preserve`. Nothing
 * here reads, hashes, decrypts, prints or logs content; the report names the file and its size, never a byte of it.
 */
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, stat, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SealedMove {
  readonly from: string;
  readonly to: string;
  readonly bytes: number;
  readonly mode: number;
}

/**
 * Copy one sealed file to a path that must not exist yet. Refuses a symlink or anything that is not a regular file:
 * following a link out of the home could copy a file the owner never put there.
 */
export async function moveSealed(from: string, to: string): Promise<SealedMove> {
  const source = await lstat(from);
  if (!source.isFile()) throw new Error(`sealed source is not a regular file: ${from}`);
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  // COPYFILE_EXCL: never overwrite. FICLONE: reflink where the filesystem can, a plain copy otherwise.
  await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const mode = source.mode & 0o777;
  await chmod(to, mode);
  await utimes(to, source.atime, source.mtime);
  const copied = await stat(to);
  if (copied.size !== source.size)
    throw new Error(`sealed copy is ${copied.size} bytes, source is ${source.size}: ${to}`);
  return { from, to, bytes: source.size, mode };
}

/**
 * Give a live unix socket (the v4 tmux server's) a second name inside the new home, so v5's Terminals reaches the
 * SAME running server without a restart. `link(2)` names the inode again; nothing is connected to or read.
 * Both paths must be on one filesystem — the prompt keeps the backup and the new home side by side for this.
 */
export async function linkSocket(from: string, to: string): Promise<void> {
  const source = await lstat(from);
  if (!source.isSocket()) throw new Error(`not a socket: ${from}`);
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await link(from, to);
}
