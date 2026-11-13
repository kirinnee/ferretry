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
import type { PinnedFolder } from './no-link.ts';

export interface ResolvedPlace {
  /** The absolute path every write goes to: the resolved parent, then the rest of the way down. */
  readonly path: string;
  /** The deepest EXISTING folder above `path`, resolved: the walk of `lstat` checks starts here. */
  readonly anchor: string;
  /** Every component from `/` down to `anchor`, with the identity it had when it was resolved. */
  readonly pins: readonly PinnedFolder[];
}

/** The identity of `/` and each folder down to `anchor` (a resolved path, so none is a link); `[]` when unreadable. */
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
      if (facts.isSymbolicLink() || !facts.isDirectory()) return [];
      pins.push({ path: walked, dev: facts.dev, ino: facts.ino });
    } catch {
      return [];
    }
  }
  return pins;
}

/** Resolves the parent of `path` once (its deepest existing ancestor through `realpath`, the absent rest appended). */
export async function resolvePlace(path: string): Promise<ResolvedPlace> {
  const name = basename(path);
  const tail: string[] = [];
  let current = dirname(path);
  for (;;) {
    try {
      const anchor = await realpath(current);
      return { path: join(anchor, ...tail.reverse(), name), anchor, pins: await pinChain(anchor) };
    } catch {
      const up = dirname(current);
      // Nothing above resolves (a root that cannot be read): keep the spelling, the write checks refuse what is wrong.
      if (up === current) return { path, anchor: current, pins: [] };
      tail.push(basename(current));
      current = up;
    }
  }
}
