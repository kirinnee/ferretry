/**
 * The conversion report file. Its parent is resolved ONCE (a person may spell it through a system link such as macOS
 * `/tmp`), the report is written against that resolved path, and every component from the resolved parent down is
 * `lstat`ed again at write time, so a link swapped in after the resolve refuses. A link at the report's own path refuses
 * too, and the open itself refuses a link (`O_NOFOLLOW`), so the report is never written through one.
 */
import { constants } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { LinkOnWritePathError, refuseLinkOnPath } from './v5/no-link.ts';
import { type ResolvedPlace, resolvePlace } from './v5/resolved-place.ts';

/** The sentence for a link on the report's path, naming the link and never what it points to. */
const linkSentence = (link: string, reason: 'link' | 'changed' = 'link'): string =>
  reason === 'link'
    ? `${link} is a link: replace it with a real file or folder (or name another with --report), then run again`
    : `${link} is not the folder it was when the run started: put the real folder back (or name another report with --report), then run again`;

/**
 * Resolves the report's parent once. `problem` is set when a link (or a folder that is not one) is on its path: then
 * write nothing. A refusal while the parent chain is pinned has no `place` at all, so there is nothing to write at.
 */
export async function resolveReport(
  path: string,
): Promise<
  | { readonly place: ResolvedPlace; readonly problem?: string }
  | { readonly place?: undefined; readonly problem: string }
> {
  let place: ResolvedPlace;
  try {
    place = await resolvePlace(path);
  } catch (error) {
    if (error instanceof LinkOnWritePathError) return { problem: linkSentence(error.link, error.reason) };
    throw error;
  }
  try {
    refuseLinkOnPath(place.anchor, place.path, place.pins);
  } catch (error) {
    if (error instanceof LinkOnWritePathError) return { place, problem: linkSentence(error.link, error.reason) };
    throw error;
  }
  return { place };
}

/** Writes the report at the resolved place; a link on its path (now) refuses and writes nothing. */
export async function writeReportFile(place: ResolvedPlace, text: string): Promise<{ readonly problem?: string }> {
  try {
    refuseLinkOnPath(place.anchor, place.path, place.pins);
    await writeFile(place.path, text, {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    });
  } catch (error) {
    if (error instanceof LinkOnWritePathError) return { problem: linkSentence(error.link, error.reason) };
    // A link swapped in at the very last instant: the open itself refused it.
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP')
      return { problem: linkSentence(place.path) };
    throw error;
  }
  return {};
}
