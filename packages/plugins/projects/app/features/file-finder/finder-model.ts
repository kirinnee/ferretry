/**
 * THE FINDER'S WORDS, AS PURE FUNCTIONS (&F6061 U7).
 *
 * The daemon owns the index and says what it could and could not see (`ProjectIndexSummary`); this file only turns that
 * into sentences. Two rules carry over from the ferret file search and are the point of the file:
 *
 *  - A PARTIAL INDEX NEVER ANNOUNCES AN EMPTY OR COMPLETE RESULT. "No file matches" is a claim only a complete index
 *    supports; over a partial one the sentence says the file may exist beyond what was looked at.
 *  - A BOUND THAT BIT IS SAID, AND WHERE. At the cap the banner names the folders holding the most files, so the person
 *    can see what ate the budget instead of being told only that something did.
 *
 * Nothing here reads the clock, the DOM or the daemon.
 */
import { MAX_PROJECT_WORKTREES_NAMED, type ProjectIndexSummary } from '../../../contract/index.ts';

const number = (value: number): string => value.toLocaleString('en-US');

const plural = (count: number, one: string, many: string): string => `${number(count)} ${count === 1 ? one : many}`;

/** How many of a skip reason the summary counts, or 0. */
const skippedCount = (summary: ProjectIndexSummary, reason: ProjectIndexSummary['skipped'][number]['reason']): number =>
  summary.skipped.find(skip => skip.reason === reason)?.count ?? 0;

/** One row of the banner's folder line. */
export interface BannerFolder {
  readonly folder: string;
  readonly files: string;
}

/** What the coverage block says, in the order it is drawn. Every field is a finished sentence or absent. */
export interface CoverageBanner {
  /** `cap`: a bound bit (the count says where); `partial`: a folder could not be read; `notes`: complete, with skips to mention. */
  readonly kind: 'cap' | 'partial' | 'notes';
  readonly headline: string | null;
  readonly folders: readonly BannerFolder[];
  readonly skipped: string | null;
  readonly tip: string | null;
}

/** "3 nested worktrees" — or "at least 50" when the daemon named only as many as it keeps. */
const worktreeWords = (summary: ProjectIndexSummary): string | null => {
  const named = summary.nestedWorktrees.length;
  if (named === 0) return null;
  const count = named >= MAX_PROJECT_WORKTREES_NAMED ? `at least ${number(named)}` : number(named);
  return `${count} nested ${named === 1 ? 'worktree' : 'worktrees'}`;
};

/** "3 nested worktrees, 41 secret-looking names" — what was deliberately left out, or `null` when nothing was. */
export const skippedLine = (summary: ProjectIndexSummary): string | null => {
  const parts = [
    worktreeWords(summary),
    skippedCount(summary, 'denied') === 0
      ? null
      : plural(skippedCount(summary, 'denied'), 'secret-looking name', 'secret-looking names'),
    skippedCount(summary, 'unreadable') === 0
      ? null
      : plural(skippedCount(summary, 'unreadable'), 'folder that could not be read', 'folders that could not be read'),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `Skipped: ${parts.join(', ')}.`;
};

/**
 * The coverage block of one index, or `null` when it was complete and left nothing worth saying.
 *
 * `indexed` is how many files are held. When a bound bit it is the cap, so "Showing 50,000 of more than 50,000" is that
 * one number twice on purpose: the daemon cannot know the total it did not reach, only that there is more.
 */
export const coverageBanner = (summary: ProjectIndexSummary): CoverageBanner | null => {
  const skipped = skippedLine(summary);
  const cut = skippedCount(summary, 'truncated') > 0;
  if (cut)
    return {
      kind: 'cap',
      headline: `Showing ${number(summary.indexed)} of more than ${number(summary.indexed)} files — the rest were not looked at.`,
      folders: summary.biggestFolders.map(entry => ({ folder: `${entry.folder}/`, files: number(entry.files) })),
      skipped,
      tip: 'Tip: add big generated folders to .gitignore.',
    };
  if (summary.coverage === 'partial')
    return {
      kind: 'partial',
      headline: 'Some folders could not be read, so this list may be missing files.',
      folders: [],
      skipped,
      tip: null,
    };
  return skipped === null ? null : { kind: 'notes', headline: null, folders: [], skipped, tip: null };
};

/** "Most files: data/ (31,200), packages/ (12,400)." — or `null` when no folder is named. */
export const foldersLine = (folders: readonly BannerFolder[]): string | null =>
  folders.length === 0 ? null : `Most files: ${folders.map(entry => `${entry.folder} (${entry.files})`).join(', ')}.`;

/** What the result list says when it is empty. Over a partial index it never says there is nothing. */
export const emptyResultSentence = (query: string, summary: ProjectIndexSummary): string => {
  const asked = query.trim();
  const looked = plural(summary.indexed, 'file', 'files');
  if (summary.coverage === 'partial')
    return asked === ''
      ? `No files were listed. This index is partial (${looked} looked at), so files may exist that it did not reach.`
      : `No match for “${asked}” among the ${looked} that were looked at. This index is partial, so the file may exist beyond them.`;
  return asked === '' ? 'This project has no files to list.' : `No file in this project matches “${asked}”.`;
};

/** "Showing 50 of 312 matches", or `null` when every match is on screen. */
export const matchCountLine = (shown: number, total: number): string | null =>
  total > shown ? `Showing ${number(shown)} of ${number(total)} matches.` : null;

/** One result's two halves: the folder it is in (empty at the top level) and its name. */
export const splitPath = (path: string): { readonly folder: string; readonly name: string } => {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { folder: '', name: path } : { folder: path.slice(0, cut + 1), name: path.slice(cut + 1) };
};

/** The absolute path a person pastes into a terminal: the project's folder and the relative path, joined once. */
export const absolutePath = (projectPath: string, relative: string): string =>
  `${projectPath.replace(/\/+$/u, '')}/${relative}`;

/** The longest search text the daemon takes (`FerretSearchQuerySchema`). */
const MAX_QUERY = 200;

/**
 * What is sent as `?q=`: control characters dropped, trimmed, bounded to what the daemon takes. The daemon refuses the
 * rest with a 400, and a pasted line break should search, not fail.
 */
export const searchText = (raw: string): string =>
  [...raw]
    .map(char => ((char.codePointAt(0) ?? 0) < 0x20 || char === '\u007f' ? ' ' : char))
    .join('')
    .trim()
    .slice(0, MAX_QUERY)
    .trim();

/** The search text an address seeds the finder with (`?find=…`, how "Go to file" arrives), or `''`. */
export const seedQuery = (search: string): string => searchText(new URLSearchParams(search).get('find') ?? '');
