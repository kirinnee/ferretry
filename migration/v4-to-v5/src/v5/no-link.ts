/**
 * No write through a link. Every path the converter writes or creates in the new home goes through
 * {@link refuseLinkOnPath} first (`V5Writer.resolve` and the writer's own file placement call it): the new home, and
 * each folder on the way down to the path, is `lstat`ed, and a link on any of them refuses, naming that link and never
 * what it points to. `lstat` only, so the check itself follows nothing. A component that does not exist yet ends the
 * walk: nothing deeper can be a link.
 */
import { lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Thrown for a link on a write path; the message names the link and the remedy. */
export class LinkOnWritePathError extends Error {
  override readonly name = 'LinkOnWritePathError';
  constructor(readonly link: string) {
    super(`${link} is a link, so nothing was written through it: replace it with a real folder, then run again`);
  }
}

/** Throws {@link LinkOnWritePathError} when `home` or a component of `path` below it is a link. */
export function refuseLinkOnPath(home: string, path: string): void {
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
