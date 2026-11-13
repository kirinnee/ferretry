/**
 * Where an OUTPUT path really is, decided once. A person may spell the new home (or the report) through a system link
 * (macOS `/tmp` -> `/private/tmp`, `/var`, `/etc`), so a link ABOVE the output cannot be refused outright. The parent is
 * resolved ONCE (`realpath` is allowed on the output side only, never on the v4 source), every write then goes to that
 * resolved absolute path, and every component from the resolved parent down is `lstat`ed again at write time
 * ({@link refuseLinkOnPath}), so a link swapped in after the resolve refuses.
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface ResolvedPlace {
  /** The absolute path every write goes to: the resolved parent, then the rest of the way down. */
  readonly path: string;
  /** The deepest EXISTING folder above `path`, resolved: the walk of `lstat` checks starts here. */
  readonly anchor: string;
}

/** Resolves the parent of `path` once (its deepest existing ancestor through `realpath`, the absent rest appended). */
export async function resolvePlace(path: string): Promise<ResolvedPlace> {
  const name = basename(path);
  const tail: string[] = [];
  let current = dirname(path);
  for (;;) {
    try {
      const anchor = await realpath(current);
      return { path: join(anchor, ...tail.reverse(), name), anchor };
    } catch {
      const up = dirname(current);
      // Nothing above resolves (a root that cannot be read): keep the spelling, the write checks refuse what is wrong.
      if (up === current) return { path, anchor: current };
      tail.push(basename(current));
      current = up;
    }
  }
}
