import { chmod, lstat, readdir, readlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * ONE WALK OVER A TREE THIS CLIENT OWNS, shared by the two verbs that remove one.
 *
 * `retire` clears the snapshot store an earlier release left; `reset` clears the whole installation.
 * They differ in what a failure means and in whether they remove at all — never in how a tree is
 * counted, whether a symbolic link is followed, or how a sealed directory is opened. Those three are
 * exactly the properties that are dangerous to get wrong twice, so they are written once.
 *
 * A SYMBOLIC LINK IS COUNTED AND NEVER FOLLOWED. `lstat` is what makes that true rather than a
 * comment: the garbage-collection roots are links into the Nix store, and `FY_HOME` may hold one
 * legitimate link of its own, so following either would recursively delete data that belongs to
 * somebody else. Links whose target lies outside the tree are also reported, so the caller can name
 * them to a person before anything is removed.
 */

/** What one walk found. */
export interface TreeWalk {
  /** Every entry that is not a directory, symbolic links included. */
  files: number;
  bytes: number;
  /** `<path relative to the tree> -> <target>` for every link that points out of the tree. */
  readonly escapingLinks: string[];
}

/** How the walk behaves on the way down. */
export interface TreeWalkOptions {
  /**
   * Force write permission back onto each directory before its children are read.
   *
   * The retired snapshot store sealed every snapshot directory to mode 0555 when its build finished,
   * and an entry inside a directory can only be unlinked by somebody who may write to that directory —
   * so an ordinary recursive remove fails with EACCES on the first one it reaches. Off for a
   * measurement, which must not modify the tree it is only looking at.
   */
  readonly unseal: boolean;
}

/**
 * Measure `root`, and open it for removal when asked to.
 *
 * `root` itself is assumed to exist; the caller has already decided what an absent tree means, and the
 * two callers mean different things by it.
 */
export async function walkTree(root: string, options: TreeWalkOptions): Promise<TreeWalk> {
  const walk: TreeWalk = { files: 0, bytes: 0, escapingLinks: [] };
  await descend(root, root, walk, options);
  return walk;
}

async function descend(root: string, path: string, walk: TreeWalk, options: TreeWalkOptions): Promise<void> {
  const state = await lstat(path);
  if (state.isSymbolicLink()) {
    walk.files += 1;
    const target = await readlink(path).catch(() => undefined);
    if (target !== undefined && escapes(root, path, target)) {
      walk.escapingLinks.push(`${relative(root, path)} -> ${target}`);
    }
    return;
  }
  if (!state.isDirectory()) {
    walk.files += 1;
    walk.bytes += state.size;
    return;
  }
  // Chmodded BEFORE its children are read: a directory with no execute or write bit can neither be
  // listed nor have anything taken out of it, and a removal needs both on the way down.
  if (options.unseal) await chmod(path, 0o700);
  for (const entry of await readdir(path)) await descend(root, join(path, entry), walk, options);
}

/** Does this link point out of the tree it lives in? Resolved textually — nothing on it is read. */
function escapes(root: string, link: string, target: string): boolean {
  const absolute = isAbsolute(target) ? target : resolve(join(link, '..'), target);
  const rest = relative(root, absolute);
  return rest === '' || rest.startsWith('..') || isAbsolute(rest);
}
