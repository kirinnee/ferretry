/**
 * WHAT A PULL REQUEST CHANGED (docs/agenda.md § Try it only when there is something to try). The watcher reads each
 * PR's changed files in its one GraphQL query; this decides, from those paths alone, whether the PR touched anything a
 * person could try. Pure and total.
 *
 * - `docs-tests`: EVERY changed file is a doc, a design note, a test, or something that only drives tests.
 * - `code`: any other file, or more files than GitHub listed (the unseen ones may be anything).
 * - `undefined`: unknown. GitHub listed fewer files than it counted, or none at all: nothing is claimed, and a reader
 *   treats it as code.
 */
import type { PrChangeKind } from '@ferretry/protocol';

/** How many changed files one query reads: the `files(first: …)` of the PR fields. */
export const PR_FILES_READ = 100;

/**
 * The paths that are docs, design or tests. A directory name matches at any depth (`packages/x/tests/…`); `docs/` only
 * at the top, since a `docs/` folder inside a package may well be shipped. A Markdown file anywhere is a doc. A
 * `harness/` folder counts only at a package's top (`packages/pwa/harness/`, the screenshot and bench pages): the
 * `harness/` folders under `src/` are the session harness the product runs, so they are code.
 */
const DOCS_TESTS: readonly RegExp[] = [
  /^docs\//u,
  /\.mdx?$/iu,
  /(?:^|\/)tests\//u,
  /(?:^|\/)__tests__\//u,
  /^packages\/[^/]+\/harness\//u,
  /(?:^|\/)fixtures\//u,
  /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/u,
];

/** Whether one changed file is a doc, a design note or a test. */
export const isDocsOrTestsPath = (path: string): boolean => DOCS_TESTS.some(pattern => pattern.test(path));

/** The kind of change a PR made, from GitHub's count of its files and the paths it listed. */
export const classifyPrFiles = (totalCount: number, paths: readonly string[]): PrChangeKind | undefined => {
  if (totalCount <= 0 || paths.length === 0) return undefined;
  if (totalCount > PR_FILES_READ) return 'code';
  if (paths.length !== totalCount) return undefined;
  return paths.every(isDocsOrTestsPath) ? 'docs-tests' : 'code';
};
