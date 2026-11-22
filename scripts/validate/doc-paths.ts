/**
 * THE DOC-PATHS CHECK: every repository path a contract document names is a path that exists.
 *
 * `docs/fy-render.md` and `docs/reference-standard.md` tell an implementer where the code is ("the reference
 * implementation is …", "the test that pins this is …"). A path that was moved or deleted turns those sentences into
 * a trap that reads as an instruction, so the two documents are held to the tree: a named path that is not tracked
 * fails here, naming the document, the line and the path (r12 H9; the package the documents named for a year,
 * `packages/pwa`, no longer exists).
 *
 * WHAT COUNTS AS "NAMING A PATH". Four shapes only, so the check cannot be argued with:
 *  - a code span (`like/this.ts`) whose text starts with a top-level directory the repository tracks
 *    (`packages/`, `docs/`, `scripts/`, `.claude/`, …) or with one a package used to own (`lib/`, `components/`,
 *    `styles/`, `tests/`),
 *  - a code span with a directory in it that ends `.test.ts`, `.test.tsx` or `.sh`: a test or a script is always a
 *    path from the root, even when the directory it names is the one that left the tree,
 *  - a test named by its file name alone (`foo.test.ts`): some tracked file must carry that name, and
 *  - the target of a relative Markdown link (`[x](board.md#a)`, `[x](../handover.md)`), resolved from the document.
 * A span with a glob (`*`, `{`), a placeholder (`<name>`) or an ellipsis is a description of a family of paths, not
 * one path, and is skipped; a trailing `:120` / `:120-140` (a line) or `#anchor` is cut off before the lookup. A
 * span that is an example of the reference grammar (`@src/api.ts`) starts with a sigil, not a directory, and so is
 * never read here.
 *
 * EXISTS MEANS TRACKED. A path is checked against `git ls-files`, not the disk, so a generated or ignored file that
 * happens to be present on one machine cannot make a document pass here and fail in CI. A directory exists when a
 * tracked file lives under it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';

/** The documents whose named paths are held to the tree. */
export const CONTRACT_DOCS: readonly string[] = ['docs/fy-render.md', 'docs/reference-standard.md'];

/** One path a document names that is not in the tree. */
export interface MissingPath {
  readonly doc: string;
  readonly line: number;
  readonly path: string;
}

/** The tracked files of the repository at `root`, as a set, with every directory above them. */
export function trackedPaths(root: string): {
  readonly files: ReadonlySet<string>;
  readonly dirs: ReadonlySet<string>;
} {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const files = new Set(listed.stdout.split('\0').filter(path => path !== ''));
  const dirs = new Set<string>();
  for (const file of files) {
    for (let at = file.lastIndexOf('/'); at > 0; at = file.lastIndexOf('/', at - 1)) dirs.add(file.slice(0, at));
  }
  return { files, dirs };
}

/** A code span's text, or a link target, cut down to the one path it names; `null` when it names none (or a family). */
function pathOf(text: string): string | null {
  if (/[\s*{}<>…|]|\.\.\.|\$\{/u.test(text)) return null;
  const cut = text
    .replace(/#.*$/u, '')
    .replace(/:\d+(?:-\d+)?$/u, '')
    .replace(/\/$/u, '');
  return cut === '' ? null : cut;
}

/**
 * Directories a document once named relative to ONE package (`lib/…`, `components/…`, `styles/…`, `tests/…`). Nothing
 * at the root is called that, so such a span is a path that lost its package, and it is read from the root and found
 * missing rather than skipped.
 */
const PACKAGE_RELATIVE: ReadonlySet<string> = new Set(['lib', 'components', 'styles', 'tests']);
const TEST_FILE = /\.test\.tsx?$/u;
const TEST_OR_SCRIPT = /\.(?:test\.tsx?|sh)$/u;

/** One path a document names; `bare` is a test named by its file name alone (any directory will do). */
export interface NamedPath {
  readonly line: number;
  readonly path: string;
  readonly bare?: true;
}

/** Every path the text of `doc` names, with the 1-based line it is on. Code fences are skipped: they show examples. */
export function namedPaths(doc: string, text: string, topLevel: ReadonlySet<string>): readonly NamedPath[] {
  const named: NamedPath[] = [];
  let fence: string | null = null;
  text.split('\n').forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker[0] ?? null;
      else if (marker[0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    for (const span of line.matchAll(/`([^`]+)`/gu)) {
      const path = pathOf(span[1] ?? '');
      if (path === null) continue;
      // A path from the repository root: it starts in a directory the repository tracks, OR it is a test or a script
      // (so a `tests/e2e/…` file that left the tree with its top-level directory is found, not skipped).
      const first = path.split('/')[0] ?? '';
      if (path.includes('/') && (topLevel.has(first) || PACKAGE_RELATIVE.has(first) || TEST_OR_SCRIPT.test(path)))
        named.push({ line: index + 1, path });
      // A test named by its file name alone is held to the tree too: some tracked file must carry that name.
      else if (!path.includes('/') && TEST_FILE.test(path)) named.push({ line: index + 1, path, bare: true });
    }
    // A link written INSIDE a code span (`![](url)`) is an example of Markdown, not a link of this document.
    for (const link of line.replace(/`[^`]*`/gu, '').matchAll(/\]\(([^)\s]+)\)/gu)) {
      const target = link[1] ?? '';
      if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('#')) continue;
      const path = pathOf(target);
      if (path !== null) named.push({ line: index + 1, path: normalize(join(dirname(doc), path)) });
    }
  });
  return named;
}

/** The paths the documents name that are not tracked in the repository at `root`. Reads each document from `root`. */
export function missingPaths(root: string, docs: readonly string[] = CONTRACT_DOCS): readonly MissingPath[] {
  const { files, dirs } = trackedPaths(root);
  const topLevel = new Set([...files].map(file => file.split('/')[0] ?? '').filter(top => top !== ''));
  const names = new Set([...files].map(file => file.slice(file.lastIndexOf('/') + 1)));
  const missing: MissingPath[] = [];
  for (const doc of docs) {
    const text = readFileSync(join(root, doc), 'utf8');
    for (const { line, path, bare } of namedPaths(doc, text, topLevel)) {
      const found = bare === true ? names.has(path) : files.has(path) || dirs.has(path);
      if (!found) missing.push({ doc, line, path });
    }
  }
  return missing;
}

/**
 * The gate: 0 when every path the contract documents name is tracked, 1 naming each one that is not, 2 when the check
 * itself could not run (no git, an unreadable document). Exit codes follow the repo convention for `scripts/validate/`.
 */
export function main(root: string): number {
  let missing: readonly MissingPath[];
  try {
    missing = missingPaths(root);
  } catch (error) {
    console.error(`❌ the doc-paths check could not run: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (missing.length === 0) {
    console.log(`✅ every repository path ${CONTRACT_DOCS.join(' and ')} name is tracked`);
    return 0;
  }
  for (const { doc, line, path } of missing)
    console.error(`❌ ${doc}:${line} names a path that is not tracked: ${path}`);
  console.error(
    '\nA contract document tells an implementer where the code is; a moved or deleted path turns that sentence into a trap.\n' +
      "Fix the path in the document (or the document's claim), not the check. See scripts/validate/doc-paths.ts.",
  );
  return 1;
}

if (import.meta.main) process.exit(main(resolve(process.argv[2] ?? '.')));
