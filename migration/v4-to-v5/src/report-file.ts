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
const linkSentence = (link: string): string =>
  `${link} is a link: replace it with a real file or folder (or name another with --report), then run again`;

/** Resolves the report's parent once; `problem` is set when a link is already on its path. */
export async function resolveReport(
  path: string,
): Promise<{ readonly place: ResolvedPlace; readonly problem?: string }> {
  const place = await resolvePlace(path);
  try {
    refuseLinkOnPath(place.anchor, place.path);
  } catch (error) {
    if (error instanceof LinkOnWritePathError) return { place, problem: linkSentence(error.link) };
    throw error;
  }
  return { place };
}

/** Writes the report at the resolved place; a link on its path (now) refuses and writes nothing. */
export async function writeReportFile(place: ResolvedPlace, text: string): Promise<{ readonly problem?: string }> {
  try {
    refuseLinkOnPath(place.anchor, place.path);
    await writeFile(place.path, text, {
      mode: 0o600,
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    });
  } catch (error) {
    if (error instanceof LinkOnWritePathError) return { problem: linkSentence(error.link) };
    // A link swapped in at the very last instant: the open itself refused it.
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP')
      return { problem: linkSentence(place.path) };
    throw error;
  }
  return {};
}
