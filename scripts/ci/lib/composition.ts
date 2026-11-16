/**
 * THE ONE READER of `composition.tsv`: where every package declares the files that are its composition (the few
 * hand-written seams a feature must not rewrite) and its registries (the lists a feature may only add one line to).
 * Docs: docs/standards/architecture "A feature adds files and lines; it never rewrites shared code".
 *
 * One file per package, `<package>/composition.tsv` (the repository root's own `composition.tsv` holds `scripts/`), so a
 * new package declares itself by adding a file and no shared list is edited. Columns, tab separated, one entry per line:
 *
 *   kind        `composition` (hand-written seam; an edit needs `## Contract change`), `registry` (a sorted list of one entry
 *               per line; one added line is exempt), or `oversize` (a size ceiling; read here, judged by the H6 size check)
 *   path        relative to the package folder (to the repository root in the root file); no `..`, no leading `/`
 *   limit       `-` for composition and registry; the line ceiling for oversize
 *   expires     `-` for composition and registry; the `YYYY-MM-DD` an oversize entry comes back for a decision
 *   reason      one line: why this file is declared
 *
 * Entries are sorted by path, then kind, and the first line is the fixed header, so two packages' (or two features')
 * adds land on different lines and `.gitattributes` can mark the file `merge=union`. Not in package.json: a JSON list's last
 * entry has no comma, so an append would edit a shared line. Not in the manifest: that is runtime data shipped in the binary.
 *
 * Pure over text: the caller supplies `read`, so the same code reads the working tree (the validator), the PR's base
 * commit (the guard: a PR cannot un-declare a file and edit it in one go) and any commit (the replay over history).
 */

export const COMPOSITION_FILE = 'composition.tsv';
export const COMPOSITION_HEADER = 'kind\tpath\tlimit\texpires\treason';
export const KINDS = ['composition', 'registry', 'oversize'] as const;
export type CompositionKind = (typeof KINDS)[number];

export interface CompositionEntry {
  readonly kind: CompositionKind;
  /** Repository-relative path of the declared file. */
  readonly path: string;
  /** The package folder (repo-relative; '' for the repository root) whose `composition.tsv` declares it. */
  readonly owner: string;
  readonly limit: string;
  readonly expires: string;
  readonly reason: string;
  /** 1-based line in its `composition.tsv`. */
  readonly line: number;
}

export interface CompositionProblem {
  /** `<owner>/composition.tsv:<line>`. */
  readonly where: string;
  readonly message: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const byPathThenKind = (a: { path: string; kind: string }, b: { path: string; kind: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;

const join = (owner: string, path: string): string => (owner === '' ? path : `${owner}/${path}`);
export const compositionFileOf = (owner: string): string => join(owner, COMPOSITION_FILE);

/**
 * One `composition.tsv`: its entries and every way it is malformed (wrong header, wrong column count, unknown kind, a bad
 * path, a `limit`/`expires` that does not fit its kind, out of order, a duplicate, no reason). Total over every string.
 */
export function parseComposition(
  owner: string,
  text: string,
): { readonly entries: readonly CompositionEntry[]; readonly problems: readonly CompositionProblem[] } {
  const file = compositionFileOf(owner);
  const problems: CompositionProblem[] = [];
  const entries: CompositionEntry[] = [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines[0] !== COMPOSITION_HEADER)
    problems.push({
      where: `${file}:1`,
      message: `the first line must be the header \`${COMPOSITION_HEADER}\` (tab separated)`,
    });
  lines.slice(1).forEach((raw, index) => {
    const line = index + 2;
    const where = `${file}:${line}`;
    const cells = raw.split('\t');
    if (cells.length !== 5) {
      problems.push({
        where,
        message: `expected 5 tab-separated columns (kind, path, limit, expires, reason), found ${cells.length}`,
      });
      return;
    }
    const [kind, path, limit, expires, reason] = cells as [string, string, string, string, string];
    if (!(KINDS as readonly string[]).includes(kind)) {
      problems.push({ where, message: `unknown kind "${kind}" (one of ${KINDS.join(', ')})` });
      return;
    }
    if (
      path === '' ||
      path.startsWith('/') ||
      path.split('/').some(part => part === '..' || part === '' || part === '.')
    )
      problems.push({
        where,
        message: `"${path}" is not a clean path relative to ${owner === '' ? 'the repository root' : owner}`,
      });
    if (kind === 'oversize') {
      if (!/^[1-9]\d*$/.test(limit))
        problems.push({ where, message: `oversize needs a line limit in "limit", found "${limit}"` });
      if (!DATE.test(expires))
        problems.push({ where, message: `oversize needs a YYYY-MM-DD in "expires", found "${expires}"` });
    } else if (limit !== '-' || expires !== '-')
      problems.push({ where, message: `${kind} takes "-" in "limit" and "expires"` });
    if (reason.trim().length < 3) problems.push({ where, message: `"${path}" has no reason` });
    entries.push({ kind: kind as CompositionKind, path: join(owner, path), owner, limit, expires, reason, line });
  });
  entries.forEach((entry, index) => {
    const previous = entries[index - 1];
    if (previous === undefined) return;
    const order = byPathThenKind(previous, entry);
    const where = `${file}:${entry.line}`;
    if (order > 0)
      problems.push({ where, message: `"${entry.path}" is out of order: entries are sorted by path, then kind` });
    if (order === 0) problems.push({ where, message: `"${entry.path}" is declared twice as ${entry.kind}` });
  });
  return { entries, problems };
}

/** Every owner folder that may hold a `composition.tsv`: the repository root and each package folder. */
export const owners = (packageRoots: readonly string[]): readonly string[] => ['', ...[...packageRoots].sort()];

export interface Declared {
  readonly entries: readonly CompositionEntry[];
  readonly problems: readonly CompositionProblem[];
}

/**
 * Every declaration of the repository: each owner's `composition.tsv` read through `read` (repo-relative path → text, or
 * undefined when that file does not exist). A path declared by two packages is a problem: one fact, one owner.
 */
export function readDeclared(packageRoots: readonly string[], read: (path: string) => string | undefined): Declared {
  const entries: CompositionEntry[] = [];
  const problems: CompositionProblem[] = [];
  for (const owner of owners(packageRoots)) {
    const text = read(compositionFileOf(owner));
    if (text === undefined) continue;
    const parsed = parseComposition(owner, text);
    entries.push(...parsed.entries);
    problems.push(...parsed.problems);
  }
  // One path may carry two kinds (a seam that is also `oversize`), never the same kind twice, and never from two packages.
  const seen = new Map<string, CompositionEntry>();
  for (const entry of entries) {
    const key = `${entry.kind}\0${entry.path}`;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, entry);
    else
      problems.push({
        where: `${compositionFileOf(entry.owner)}:${entry.line}`,
        message: `"${entry.path}" is already declared as ${entry.kind} in ${compositionFileOf(first.owner)}:${first.line}`,
      });
  }
  return { entries, problems };
}

/** The declared paths the guard watches: compositions and registries (oversize is the size check's, not this guard's). */
export const guarded = (entries: readonly CompositionEntry[]): ReadonlyMap<string, CompositionEntry> =>
  new Map(entries.filter(entry => entry.kind !== 'oversize').map(entry => [entry.path, entry] as const));

/**
 * What the validator finds beyond the format: a declared path that is not a file, and a declaration that sits outside its
 * own package (`packages/a/composition.tsv` may only name files under `packages/a`; the root file names `scripts/` and
 * other root files, never a package's).
 */
export function checkPaths(
  declared: Declared,
  packageRoots: readonly string[],
  exists: (path: string) => boolean,
): readonly CompositionProblem[] {
  const problems = [...declared.problems];
  for (const entry of declared.entries) {
    const where = `${compositionFileOf(entry.owner)}:${entry.line}`;
    if (!exists(entry.path)) problems.push({ where, message: `"${entry.path}" does not exist` });
    if (entry.owner === '' && packageRoots.some(root => entry.path.startsWith(`${root}/`)))
      problems.push({
        where,
        message: `"${entry.path}" belongs to a package: declare it in that package's composition.tsv`,
      });
  }
  return problems;
}
