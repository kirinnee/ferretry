/**
 * No write through a link, and no write below a folder that is not the one preflight looked at. Every path the
 * converter writes or creates in the new home goes through {@link refuseLinkOnPath} first (`V5Writer.resolve` and the
 * writer's own file placement call it):
 *
 *  - the folders ABOVE the new home are pinned at preflight ({@link PinnedFolder}: the identity, device and inode, of
 *    EVERY component from `/` down to the resolved anchor), and each is looked at again here: it must still be the same
 *    real folder, not a link. A link swapped in anywhere above the anchor therefore refuses, not only one below it;
 *  - the new home, and each folder on the way down to the path, is `lstat`ed, and a link on any of them refuses.
 *
 * The message names the folder and never what it points to. `lstat` only, so the check itself follows nothing. A
 * component below the anchor that does not exist yet ends the walk: nothing deeper can be a link.
 */
import { lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** One real folder above the new home, as preflight saw it: its path and identity. */
export interface PinnedFolder {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Thrown for a link on a write path (or a pinned folder that is not the one preflight saw); names the folder. */
export class LinkOnWritePathError extends Error {
  override readonly name = 'LinkOnWritePathError';
  constructor(
    readonly link: string,
    readonly reason: 'link' | 'changed' = 'link',
  ) {
    super(
      reason === 'link'
        ? `${link} is a link, so nothing was written through it: replace it with a real folder, then run again`
        : `${link} is not the folder it was when the run started, so nothing was written through it: put the real folder back, then run again`,
    );
  }
}

/** Throws {@link LinkOnWritePathError} when any pinned folder is now a link or a different folder. */
export function verifyPinned(pins: readonly PinnedFolder[]): void {
  for (const pin of pins) {
    let facts;
    try {
      facts = lstatSync(pin.path, { bigint: true });
    } catch {
      throw new LinkOnWritePathError(pin.path, 'changed');
    }
    if (facts.isSymbolicLink()) throw new LinkOnWritePathError(pin.path, 'link');
    if (!facts.isDirectory() || facts.dev !== pin.dev || facts.ino !== pin.ino)
      throw new LinkOnWritePathError(pin.path, 'changed');
  }
}

/**
 * Throws {@link LinkOnWritePathError} when a pinned folder above `home` changed, or when `home` or a component of
 * `path` below it is a link. `home` is the anchor (the resolved folder the walk starts at) when pins are given.
 */
export function refuseLinkOnPath(home: string, path: string, pins: readonly PinnedFolder[] = []): void {
  verifyPinned(pins);
  const rest = relative(home, path);
  const names = rest === '' || rest.startsWith('..') ? [] : rest.split(sep).filter(name => name !== '' && name !== '.');
  let walked = home;
  for (let index = -1; index < names.length; index++) {
    if (index >= 0) walked = join(walked, names[index] ?? '');
    let facts;
    try {
      facts = lstatSync(walked);
    } catch {
      // Absent (or not to be looked at): nothing deeper exists to be a link.
      return;
    }
    if (facts.isSymbolicLink()) throw new LinkOnWritePathError(walked);
  }
}
