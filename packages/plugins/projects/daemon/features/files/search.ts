import { normalizeSessionSearchQuery, type SessionFileIndexEntry } from '@ferretry/core-ferrets/contract';

/** The best matches of one search, in the order they are shown, and how many files matched in all. */
export interface FileMatches {
  readonly files: readonly SessionFileIndexEntry[];
  readonly total: number;
}

/**
 * The files of an index that match `query`, best first, cut to `limit`.
 *
 * The match is the protocol's own: a case-folded substring over the name and the path (`matchesSessionSearchQuery`,
 * `normalizeSessionSearchQuery`), so what the daemon returns is what a client's own highlighting shows. The query is
 * validated ONCE by the route and folded once here — asking the protocol's whole predicate per file would parse it fifty
 * thousand times. A name containing the text outranks a path that only does; within a rank the index's order stands
 * (shallow first), so the ranking is stable.
 *
 * No query lists the top of the index, shallow first: a finder opened before anything is typed shows the files a person
 * most often names.
 */
// read-scoped: none — it matches file NAMES already held in memory (secret-looking names were dropped when the index was built); no file text is read
export function searchFiles(
  files: readonly SessionFileIndexEntry[],
  query: string | undefined,
  limit: number,
): FileMatches {
  if (query === undefined) return { files: files.slice(0, limit), total: files.length };
  const needle = normalizeSessionSearchQuery(query);
  const byName: SessionFileIndexEntry[] = [];
  const byPath: SessionFileIndexEntry[] = [];
  for (const file of files) {
    if (file.name.toLowerCase().includes(needle)) byName.push(file);
    else if (file.path.toLowerCase().includes(needle)) byPath.push(file);
  }
  return { files: [...byName, ...byPath].slice(0, limit), total: byName.length + byPath.length };
}
