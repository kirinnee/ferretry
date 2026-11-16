/**
 * THE ONE-FOLDER RULE of a pull request into `rebuild/5.0-after`: a feature lives in its own plugin folder, and a file
 * outside it is an exception the PR body has to explain (docs/standards/architecture "One feature, one folder").
 *
 * Parallel work collides on shared files: in one week of merges the shared lists (`ports-pending.json`,
 * `knip.production.json`, the core ferrets daemon index and service, the app shell notes) were touched by 7 to 53 PRs
 * each. A PR that has to touch one says so, in the body, per file, with the reason.
 *
 *   1. The PR's own diff is `git diff --name-only --no-renames <base>...<head>` (merge-base, via `changed-files.ts`),
 *      so what a merge from the base brought in never counts.
 *   2. The HOME packages are the ones named on a `Home: <pkg>[, <pkg>]` line of the body, else the workspace package
 *      (a plugin, a core package, app, cli, std) that owns the most changed lines (all of them on a tie).
 *   3. Every changed file outside the home packages must be named under a `## Outside files` heading of the body, by
 *      path or by glob, with a reason after it. Files that never need one: `bun.lock`; `nix/ferretry.nix` and
 *      `nix/bun-deps.inputs` when a `package.json` or the lockfile changed; generated registries.
 *   4. Anything that cannot be decided (no sha, no merge-base, a `Home:` that names no package) FAILS and says why.
 *
 * `evaluate` is pure; the git, file-system and environment reads are below it.
 */
import { readdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { changedFiles, changedLines } from './changed-files.ts';

/** The only base the rule is enforced on. */
export const ONE_FOLDER_BASE_REF = 'rebuild/5.0-after';

export interface OutsideEntry {
  /** A path, a `dir/` prefix or a glob. */
  readonly pattern: string;
  /** What the author wrote after it; empty when they wrote none. */
  readonly reason: string;
}

export interface Evaluation {
  readonly ok: boolean;
  /** Package folders (repo-relative) that own this PR. */
  readonly home: readonly string[];
  /** Where `home` came from: the body's `Home:` line or the changed lines. */
  readonly homeFrom: 'home-line' | 'changed-lines' | 'none';
  /** Every changed file outside `home`, minus the allowlist. */
  readonly outside: readonly string[];
  /** Changed files outside `home` that never need a reason. */
  readonly allowed: readonly string[];
  /** Outside files that a section entry covers, with the pattern that covers them. */
  readonly explained: readonly { readonly file: string; readonly pattern: string }[];
  /** Outside files with no entry, or an entry with no reason. */
  readonly missing: readonly string[];
  /** Whether the body has an `## Outside files` heading at all. */
  readonly hasSection: boolean;
  /** Section entries that name nothing changed, or are too broad to mean anything. */
  readonly badEntries: readonly string[];
  /** Things that stop the rule from deciding (an unknown `Home:` package). */
  readonly problems: readonly string[];
}

// ─── the PR body ─────────────────────────────────────────────────────────────────────────────────────────────────

const stripComments = (body: string): string => body.replace(/<!--[\s\S]*?-->/g, '');

/** `Home: a, b` (one line, any case). Undefined when the body has none. */
export function homeLine(body: string): readonly string[] | undefined {
  const match = /^[ \t]*Home[ \t]*:[ \t]*(.+)$/im.exec(stripComments(body));
  if (match === null) return undefined;
  const names = (match[1] as string)
    .split(',')
    .map(name => name.replace(/[`*]/g, '').trim())
    .filter(name => name !== '');
  return names.length === 0 ? undefined : names;
}

const LEADING_PATH = /^\s*`([^`]+)`\s*(?:,|\+|\band\b)?\s*/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * The entries under `## Outside files`: one bullet per path or glob (or several backticked ones before the reason),
 * `path: reason`, `path - reason`, `path — reason`. A heading is only the heading when it is exactly that title.
 * Returns undefined when the body has no such heading.
 */
export function outsideEntries(body: string): readonly OutsideEntry[] | undefined {
  const lines = stripComments(body).split(/\r?\n/);
  const start = lines.findIndex(line => /^##[ \t]+Outside files[ \t]*#*[ \t]*$/i.test(line));
  if (start < 0) return undefined;
  const entries: OutsideEntry[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}[ \t]/.test(line)) break;
    const bullet = BULLET.exec(line);
    if (bullet === null) continue;
    let rest = bullet[1] as string;
    const patterns: string[] = [];
    for (let match = LEADING_PATH.exec(rest); match !== null; match = LEADING_PATH.exec(rest)) {
      patterns.push((match[1] as string).trim());
      rest = rest.slice(match[0].length);
    }
    if (patterns.length === 0) {
      const token = /^(\S+)\s*(.*)$/.exec(rest);
      if (token === null) continue;
      patterns.push((token[1] as string).replace(/[:,]+$/, ''));
      rest = token[2] as string;
    }
    const reason = rest.replace(/^[\s:,\-–—]+/, '').trim();
    for (const pattern of patterns) entries.push({ pattern, reason });
  }
  return entries;
}

/** A reason that says something: at least three characters of which one is a letter or digit. */
const hasReason = (reason: string): boolean => reason.length >= 3 && /[\p{L}\p{N}]/u.test(reason);

const hasWildcard = (pattern: string): boolean => /[*?[\]{}]/.test(pattern);

/** A pattern whose first segment is a wildcard would cover the whole repository; it explains nothing. */
const tooBroad = (pattern: string): boolean => {
  const first = pattern.replace(/^\.\//, '').split('/')[0] ?? '';
  return first === '' || hasWildcard(first);
};

const covers = (pattern: string, file: string): boolean => {
  const clean = pattern.replace(/^\.\//, '');
  if (tooBroad(clean)) return false;
  if (clean === file) return true;
  if (clean.endsWith('/')) return file.startsWith(clean);
  return hasWildcard(clean) && new Bun.Glob(clean).match(file);
};

// ─── packages and the allowlist ──────────────────────────────────────────────────────────────────────────────────

/** The package folder (the longest root that is a path prefix) a file belongs to, or undefined. */
export function packageOf(file: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const root of roots)
    if (file.startsWith(`${root}/`) && (best === undefined || root.length > best.length)) best = root;
  return best;
}

/** A `Home:` name (`board`, `plugin-board`, `@ferretry/plugin-board`, `packages/plugins/board`) as a package folder. */
export function resolveHomeName(name: string, roots: readonly string[]): string | undefined {
  const clean = name.replace(/^\.\//, '').replace(/\/$/, '');
  if (roots.includes(clean)) return clean;
  const short = clean.replace(/^@ferretry\//, '').replace(/^plugin-/, '');
  const matches = roots.filter(root => basename(root) === short);
  return matches.length === 1 ? matches[0] : undefined;
}

const isGenerated = (file: string): boolean => file.startsWith('generated/') || file.includes('/generated/');

/** Files that never need a reason: the lockfile and its install pin, and the generated registries. */
export function isAllowlisted(file: string, changed: readonly string[]): boolean {
  if (file === 'bun.lock' || isGenerated(file)) return true;
  if (file === 'nix/ferretry.nix' || file === 'nix/bun-deps.inputs')
    return changed.some(other => other === 'bun.lock' || basename(other) === 'package.json');
  return false;
}

export interface EvaluateInput {
  readonly changed: readonly string[];
  /** Changed lines per file; a file with no entry counts as one. */
  readonly lines?: ReadonlyMap<string, number>;
  /** Workspace package folders, repo-relative. */
  readonly roots: readonly string[];
  readonly body: string;
}

export function evaluate(input: EvaluateInput): Evaluation {
  const { changed, roots, body } = input;
  const problems: string[] = [];

  let home: string[] = [];
  let homeFrom: Evaluation['homeFrom'] = 'none';
  const named = homeLine(body);
  if (named !== undefined) {
    homeFrom = 'home-line';
    for (const name of named) {
      const root = resolveHomeName(name, roots);
      if (root === undefined)
        problems.push(`The "Home:" line names "${name}", which is not a package of this repository.`);
      else if (!home.includes(root)) home.push(root);
    }
  } else {
    const weight = new Map<string, number>();
    for (const file of changed) {
      const root = packageOf(file, roots);
      if (root !== undefined) weight.set(root, (weight.get(root) ?? 0) + (input.lines?.get(file) ?? 1));
    }
    const top = Math.max(0, ...weight.values());
    home = [...weight].filter(([, count]) => count === top && top > 0).map(([root]) => root);
    if (home.length > 0) homeFrom = 'changed-lines';
  }

  const inHome = (file: string): boolean => {
    const root = packageOf(file, roots);
    return root !== undefined && home.includes(root);
  };
  const outsideAll = changed.filter(file => !inHome(file));
  const allowed = outsideAll.filter(file => isAllowlisted(file, changed));
  const outside = outsideAll.filter(file => !allowed.includes(file));

  const entries = outsideEntries(body);
  const reasoned = (entries ?? []).filter(entry => hasReason(entry.reason));
  const explained: { file: string; pattern: string }[] = [];
  const missing: string[] = [];
  for (const file of outside) {
    const entry = reasoned.find(candidate => covers(candidate.pattern, file));
    if (entry === undefined) missing.push(file);
    else explained.push({ file, pattern: entry.pattern });
  }

  // Said, not failed on: such an entry explains nothing, so the files it was meant for are in `missing` anyway.
  const badEntries = (entries ?? []).flatMap(entry =>
    tooBroad(entry.pattern.replace(/^\.\//, ''))
      ? [`"${entry.pattern}" is too broad: name a folder or a file, not the whole repository`]
      : hasReason(entry.reason)
        ? []
        : [`"${entry.pattern}" has no reason after it`],
  );

  return {
    ok: missing.length === 0 && problems.length === 0,
    home,
    homeFrom,
    outside,
    allowed,
    explained,
    missing,
    hasSection: entries !== undefined,
    badEntries,
    problems,
  };
}

/** The owner-readable report: what the home is, what is outside it, what still needs a sentence. */
export function describe(result: Evaluation): string[] {
  const out: string[] = [];
  const where =
    result.home.length === 0
      ? 'none (no package owns a changed file)'
      : `${result.home.join(', ')} (${result.homeFrom === 'home-line' ? 'from the "Home:" line' : 'most changed lines'})`;
  out.push(`One-folder rule: home = ${where}`);
  for (const problem of result.problems) out.push(`❌ ${problem}`);
  if (result.allowed.length > 0)
    out.push(`Allowed without a reason (${result.allowed.length}): ${result.allowed.join(', ')}`);
  if (result.explained.length > 0) {
    out.push(`Outside the home and explained (${result.explained.length}):`);
    for (const { file, pattern } of result.explained)
      out.push(`  ✓ ${file}${pattern === file ? '' : `  (by ${pattern})`}`);
  }
  if (result.missing.length > 0) {
    out.push(
      `❌ This PR changes ${result.missing.length} file${result.missing.length === 1 ? '' : 's'} outside its own plugin folder` +
        ` without saying why. One feature lives in its own folder; a shared file is the exception and the PR body has to name it.`,
    );
    for (const file of result.missing) out.push(`  ✗ ${file}`);
    out.push(
      result.hasSection
        ? 'Add each file (or a glob that covers it) to the "## Outside files" section of the PR body, with a reason after it:'
        : 'Add a section to the PR body, one line per file (or a glob that covers it), with a reason after it:',
    );
    out.push('  ## Outside files', '  - path/to/file.ts: why this PR has to touch it');
    out.push(
      'If the files really belong together in another package, put `Home: <package>` on a line of the body instead.',
    );
  }
  for (const bad of result.badEntries) out.push(`❌ In "## Outside files": ${bad}.`);
  if (result.ok)
    out.push(
      result.outside.length === 0
        ? '✅ Every changed file is inside the home folder.'
        : '✅ Every outside file is explained.',
    );
  return out;
}

// ─── reading the repository ──────────────────────────────────────────────────────────────────────────────────────

/** The workspace package folders: the root `workspaces` globs, each `dir/*` expanded to the folders with a package.json. */
export function packageRoots(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: string[] };
  const roots: string[] = [];
  for (const pattern of manifest.workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      if (existsSync(join(root, pattern, 'package.json'))) roots.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true }))
      if (entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json')))
        roots.push(`${parent}/${entry.name}`);
  }
  return roots;
}

export interface RunResult {
  readonly code: number;
  readonly lines: readonly string[];
}

/** What the job does, given the environment the workflow passes. Never throws; every failure is an exit 1 that says why. */
export function run(root: string, env: Record<string, string | undefined>): RunResult {
  if (env.FY_ONE_FOLDER_EVENT !== 'pull_request' || env.FY_ONE_FOLDER_BASE_REF !== ONE_FOLDER_BASE_REF)
    return { code: 0, lines: [`one-folder: not a pull request into ${ONE_FOLDER_BASE_REF}; nothing to check`] };
  const base = env.FY_ONE_FOLDER_BASE_SHA ?? '';
  const head = env.FY_ONE_FOLDER_HEAD_SHA ?? '';
  const files = changedFiles(root, base, head);
  if ('error' in files)
    return {
      code: 1,
      lines: [`❌ one-folder: the changed files could not be computed (${files.error}). Re-run the job.`],
    };
  const counted = changedLines(root, base, head);
  if ('error' in counted)
    return {
      code: 1,
      lines: [`❌ one-folder: the changed lines could not be computed (${counted.error}). Re-run the job.`],
    };
  const result = evaluate({
    changed: files.files,
    lines: counted.lines,
    roots: packageRoots(root),
    body: env.FY_ONE_FOLDER_PR_BODY ?? '',
  });
  return { code: result.ok ? 0 : 1, lines: describe(result) };
}

if (import.meta.main) {
  const { code, lines } = run(process.cwd(), process.env);
  for (const line of lines) console.log(line);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY ?? '/dev/null',
    `\n### One-folder rule\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`,
  );
  process.exit(code);
}
