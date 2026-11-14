/**
 * Where an OUTPUT path really is, decided once. A person may spell the new home (or the report) through a system link
 * (macOS `/tmp` -> `/private/tmp`, `/var`, `/etc`), so a link ABOVE the output cannot be refused outright. The parent is
 * resolved ONCE (`realpath` is allowed on the output side only, never on the v4 source); the link that existed BEFORE the
 * run is resolved away, and what is pinned is the RESOLVED chain: the identity (device and inode, via `lstat`) of every
 * component from `/` down to the anchor. Every write then goes to that resolved absolute path and re-verifies the whole
 * chain plus the `lstat` walk below the anchor ({@link refuseLinkOnPath}), so a link swapped in after the resolve, at any
 * height, refuses.
 */
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, parse, sep } from 'node:path';
import { LinkOnWritePathError, type PinnedFolder } from './no-link.ts';

export interface ResolvedPlace {
  /** The absolute path every write goes to: the resolved parent, then the rest of the way down. */
  readonly path: string;
  /** The deepest EXISTING folder above `path`, resolved: the walk of `lstat` checks starts here. */
  readonly anchor: string;
  /** Every component from `/` down to `anchor`, with the identity it had when it was resolved. */
  readonly pins: readonly PinnedFolder[];
}

/**
 * The identity of `/` and each folder down to `anchor` (a resolved path, so none is a link). A component that is NOW a
 * link, is not a folder, or cannot be read refuses ({@link LinkOnWritePathError}, naming that folder, never a target):
 * a chain is whole or it is refused, never empty and never partial, so nothing can be written below a folder that was not pinned.
 */
async function pinChain(anchor: string): Promise<readonly PinnedFolder[]> {
  const { root } = parse(anchor);
  const names = anchor
    .slice(root.length)
    .split(sep)
    .filter(name => name !== '');
  const pins: PinnedFolder[] = [];
  let walked = root;
  for (let index = -1; index < names.length; index++) {
    if (index >= 0) walked = join(walked, names[index] ?? '');
    try {
      const facts = await lstat(walked, { bigint: true });
      if (facts.isSymbolicLink()) throw new LinkOnWritePathError(walked, 'link');
      if (!facts.isDirectory()) throw new LinkOnWritePathError(walked, 'changed');
      pins.push({ path: walked, dev: facts.dev, ino: facts.ino });
    } catch (error) {
      if (error instanceof LinkOnWritePathError) throw error;
      throw new LinkOnWritePathError(walked, 'changed');
    }
  }
  return pins;
}

/**
 * Resolves the parent of `path` once (its deepest existing ancestor through `realpath`, the absent rest appended).
 * Throws {@link LinkOnWritePathError} when the resolved chain is not whole real folders (see {@link pinChain}): the
 * callers treat that as "write nothing".
 */
export async function resolvePlace(path: string): Promise<ResolvedPlace> {
  const name = basename(path);
  const tail: string[] = [];
  let current = dirname(path);
  for (;;) {
    const anchor = await realpath(current).catch(() => undefined);
    // Pinned OUTSIDE the lookup's `catch`: a refusal is an answer, not "nothing here, try the folder above".
    if (anchor !== undefined)
      return { path: join(anchor, ...tail.reverse(), name), anchor, pins: await pinChain(anchor) };
    const up = dirname(current);
    // Nothing above resolves (a root that cannot be read): there is no chain to pin, so refuse rather than write.
    if (up === current) throw new LinkOnWritePathError(current, 'changed');
    tail.push(basename(current));
    current = up;
  }
}
