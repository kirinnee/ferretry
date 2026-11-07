/**
 * Moving sealed and secret files: byte for byte, never opened.
 *
 * The rule (owner, 2026-11-07; spine D16): no agent and no script ever opens a secret value. A sealed file is moved
 * with the kernel's own copy call (`copyFile`, which hands the bytes from one descriptor to another without them ever
 * becoming a JavaScript value), then given the source's mode and times — the same thing as `cp --preserve`. Nothing
 * here reads, hashes, decrypts, prints or logs content; the report names the file and its size, never a byte of it.
 */
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readdir, readlink, stat, symlink, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

/** One entry of a sealed folder as it landed: a copied file, a second name for an unreadable file, or a link. */
export interface SealedTreeEntry {
  readonly to: string;
  readonly kind: 'file' | 'hard-link' | 'link';
  readonly bytes: number;
}

const unreadable = (error: unknown): boolean =>
  ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');

/**
 * Carry a sealed folder (a harness's sign-in folder) to a path that must not exist yet, looking at nothing but
 * `lstat` and directory names:
 *
 * - a regular file is copied with {@link moveSealed}. One this program may not open (mode 0000) is given a second
 *   name with `link(2)` instead, which needs no read: the same bytes, still never opened;
 * - a symbolic link is made again as a link, never followed: `relink` gets its target (a path, not content) and
 *   says where the new link points, so a link out of the home stays the same link;
 * - a folder is made again with its mode and times, after its contents;
 * - anything else (a socket, a fifo, a device) is refused, naming the path.
 *
 * With `write: false` it only walks, so a dry run reports the same entries and writes nothing.
 */
export async function moveSealedTree(
  from: string,
  to: string,
  options: {
    readonly relink: (target: string) => string;
    readonly write: boolean;
    /** Entries left where they are, by source path (decided on the name alone, never the content). */
    readonly skip?: (source: string) => boolean;
  },
): Promise<SealedTreeEntry[]> {
  const entries: SealedTreeEntry[] = [];
  const walk = async (source: string, target: string): Promise<void> => {
    if (options.skip?.(source) === true) return;
    const facts = await lstat(source);
    if (facts.isSymbolicLink()) {
      if (options.write) {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await symlink(options.relink(await readlink(source)), target);
      }
      entries.push({ to: target, kind: 'link', bytes: 0 });
      return;
    }
    if (facts.isDirectory()) {
      if (options.write) {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await mkdir(target, { mode: 0o700 });
      }
      for (const name of (await readdir(source)).sort()) await walk(join(source, name), join(target, name));
      if (options.write) {
        await chmod(target, facts.mode & 0o777);
        await utimes(target, facts.atime, facts.mtime);
      }
      return;
    }
    if (!facts.isFile()) throw new Error(`sealed source is not a file, folder or link: ${source}`);
    if (!options.write) {
      entries.push({ to: target, kind: 'file', bytes: facts.size });
      return;
    }
    try {
      const moved = await moveSealed(source, target);
      entries.push({ to: target, kind: 'file', bytes: moved.bytes });
    } catch (error) {
      if (!unreadable(error) || (await lstat(target).catch(() => undefined)) !== undefined) throw error;
      await link(source, target);
      entries.push({ to: target, kind: 'hard-link', bytes: facts.size });
    }
  };
  await walk(from, to);
  return entries;
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
