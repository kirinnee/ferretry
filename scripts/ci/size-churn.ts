/**
 * THE SIZE/CHURN CHECK of a pull request into `rebuild/5.0-after` ("modular inside a plugin": a feature adds files, it does
 * not grow one that every other feature also edits; docs/standards/architecture "A feature adds files and lines").
 *
 * Two measurements, both on a source file (`.ts`/`.tsx`, not a test, not generated) THE PR CHANGES:
 *
 *   size   the file is over SIZE_LIMIT (1,500) lines at the PR's head.
 *   churn  the file was edited by CHURN_MERGES (6) or more of the last CHURN_WINDOW (80) first-parent merges of the base
 *          (one merge = one PR, so this counts SEPARATE PRs; a PR editing a file twenty times counts once).
 *
 * Either fails the PR UNLESS the owning package's `composition.tsv` declares the file `oversize` with a line `limit` and an
 * `expires` date (scripts/ci/lib/composition.ts): a declared file is allowed to be big or hot until that date, no bigger
 * than the limit. Past its date the declaration is a failure for any PR that touches the file, so the decision comes back
 * on a clock instead of being forgotten. A file in a `registry` entry is exempt from churn: a sorted list one line is
 * added to by design. A declaration is read at the PR's head, so a PR can add its own row; the row is in the diff, has an
 * expiry at most ~45 days out and a reason, and `composition.tsv` itself is a guarded file.
 *
 * Why the churn window and not the whole history: the number answers "is this file being fought over NOW". Why a count of
 * merges and not of commits: a merge is a PR, and PRs are what collide.
 *
 * `evaluate` is pure; git and the file system are below it. Modes: the CI step (`FY_ONE_FOLDER_*` environment, like
 * one-folder.ts), `--all` (judge every tracked source file of the working tree, as if the PR touched all: "is the base
 * green"), and `--replay [ref] [count]` (what the rule would have flagged on each of the last `count` merges).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changedFiles, git } from './changed-files.ts';
import { type CompositionEntry, readDeclared } from './lib/composition.ts';
import { ONE_FOLDER_BASE_REF, packageRoots } from './one-folder.ts';

export const SIZE_LIMIT = 1500;
export const CHURN_MERGES = 6;
export const CHURN_WINDOW = 80;

export type Rule = 'size' | 'churn' | 'ceiling' | 'expired';

export interface Finding {
  readonly file: string;
  readonly rule: Rule;
  readonly message: string;
}

export interface EvaluateInput {
  /** The files the PR changed (repo-relative). */
  readonly changed: readonly string[];
  /** Line count of a file at the PR's head; undefined when it is gone (a deleted file is not judged). */
  readonly lines: (file: string) => number | undefined;
  /** Merges of the window that edited each file. A file with no entry was edited by none. */
  readonly churn: ReadonlyMap<string, number>;
  /** Every declaration of the repository (`readDeclared(...).entries`). */
  readonly declared: readonly CompositionEntry[];
  /** `YYYY-MM-DD`: an `oversize` entry expires when this is after its `expires`. */
  readonly today: string;
  readonly sizeLimit?: number;
  readonly churnMerges?: number;
}

export interface Evaluation {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  /** The changed files that are source files, i.e. the ones that were judged. */
  readonly judged: readonly string[];
  /** Judged files that are over a limit or hot and are allowed by a live `oversize` declaration. */
  readonly allowed: readonly { readonly file: string; readonly limit: number; readonly expires: string }[];
}

const NOT_SOURCE = /(^|\/)(tests?|testing|__tests__|fixtures?|generated|node_modules)\//;
const TEST_FILE = /\.(test|spec)\.tsx?$/;

/**
 * A file the rule judges: `.ts`/`.tsx` code, not a test, a fixture, a declaration file or a generated file. Not under
 * `migration/` either: the one-time converter is a tool beside the product, kept isolated (scripts/validate/migration-isolated.sh
 * forbids any file outside its folder, a composition.tsv included, from naming it), so it cannot carry a declaration.
 */
export const isSource = (file: string): boolean =>
  /\.tsx?$/.test(file) &&
  !file.startsWith('migration/') &&
  !file.endsWith('.d.ts') &&
  !TEST_FILE.test(file) &&
  !NOT_SOURCE.test(file);

const FIX =
  'split it by feature (one file per feature) or declare it `oversize` (limit, expiry, reason) in its composition.tsv';

export function evaluate(input: EvaluateInput): Evaluation {
  const sizeLimit = input.sizeLimit ?? SIZE_LIMIT;
  const churnMerges = input.churnMerges ?? CHURN_MERGES;
  const oversize = new Map<string, CompositionEntry>();
  const registries = new Set<string>();
  for (const entry of input.declared) {
    if (entry.kind === 'oversize') oversize.set(entry.path, entry);
    else if (entry.kind === 'registry') registries.add(entry.path);
  }
  const findings: Finding[] = [];
  const allowed: { file: string; limit: number; expires: string }[] = [];
  const judged = input.changed.filter(isSource);
  for (const file of judged) {
    const size = input.lines(file);
    if (size === undefined) continue;
    const merges = registries.has(file) ? 0 : (input.churn.get(file) ?? 0);
    const big = size > sizeLimit;
    const hot = merges >= churnMerges;
    const declaration = oversize.get(file);
    if (declaration === undefined) {
      if (big)
        findings.push({
          file,
          rule: 'size',
          message: `${file} has ${size} lines (the limit is ${sizeLimit}): ${FIX}.`,
        });
      if (hot)
        findings.push({
          file,
          rule: 'churn',
          message: `${file} was edited by ${merges} of the last ${CHURN_WINDOW} merges (the limit is ${churnMerges - 1}): ${FIX}.`,
        });
      continue;
    }
    const limit = Number(declaration.limit);
    const where = `${declaration.owner === '' ? '' : `${declaration.owner}/`}composition.tsv:${declaration.line}`;
    if (declaration.expires < input.today) {
      findings.push({
        file,
        rule: 'expired',
        message: `${file}: its \`oversize\` declaration (${where}) expired on ${declaration.expires}. Split the file, or renew the declaration with a new limit, expiry and reason.`,
      });
      continue;
    }
    if (size > limit) {
      findings.push({
        file,
        rule: 'ceiling',
        message: `${file} has ${size} lines, over the ${limit} its \`oversize\` declaration (${where}) allows: a declared file may not grow.`,
      });
      continue;
    }
    if (big || hot) allowed.push({ file, limit, expires: declaration.expires });
  }
  return { ok: findings.length === 0, findings, judged, allowed };
}

/** The owner-readable report. */
export function describe(result: Evaluation, window: ChurnWindow | undefined): string[] {
  const out: string[] = [];
  out.push(
    `Size/churn check: ${result.judged.length} changed source file${result.judged.length === 1 ? '' : 's'} judged` +
      ` (size > ${SIZE_LIMIT} lines, or edited by ${CHURN_MERGES}+ of the last ${CHURN_WINDOW} merges)`,
  );
  if (window !== undefined && window.merges < CHURN_WINDOW)
    out.push(
      `⚠ only ${window.merges} merges of history were readable, not ${CHURN_WINDOW}: churn is a lower bound in this checkout`,
    );
  for (const item of result.allowed)
    out.push(`  ✓ ${item.file}: declared oversize (up to ${item.limit} lines, until ${item.expires})`);
  for (const finding of result.findings) out.push(`❌ ${finding.message}`);
  if (result.ok) out.push('✅ No changed source file is over the size or churn limit without a live declaration.');
  return out;
}

// ─── the churn window ────────────────────────────────────────────────────────────────────────────────────────────

export interface ChurnWindow {
  /** How many merges were read (fewer than CHURN_WINDOW on a shallow checkout). */
  readonly merges: number;
  /** For each file, the number of those merges that edited it. */
  readonly counts: ReadonlyMap<string, number>;
}

/**
 * Parse `git log --first-parent -m --name-only --format=%x01%H %P`: one chunk per commit, the first line its hash and
 * parents, then the files it changed relative to its FIRST parent. A commit with no parent is the shallow boundary (or a
 * root), whose "diff" is the whole tree: it is not a measurement, so it is skipped.
 */
export function parseWindow(log: string): ChurnWindow {
  const counts = new Map<string, number>();
  let merges = 0;
  for (const chunk of log.split('\u0001')) {
    if (chunk.trim() === '') continue;
    const [head = '', ...files] = chunk.split('\n');
    const parents = head.trim().split(' ').slice(1);
    if (parents.length === 0) continue;
    merges++;
    for (const file of new Set(files.filter(name => name !== ''))) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return { merges, counts };
}

/** The last `count` first-parent merges reachable from `ref`: which files each of them edited. */
export function churnWindow(root: string, ref: string, count = CHURN_WINDOW): ChurnWindow {
  const log = git(root, [
    '-c',
    'core.quotepath=off',
    'log',
    '--first-parent',
    '-m',
    '--name-only',
    '--no-renames',
    `-${count}`,
    '--format=%x01%H %P',
    ref,
  ]);
  return parseWindow(log.ok ? log.out : '');
}

// ─── reading the repository ──────────────────────────────────────────────────────────────────────────────────────

/** Lines of a text: the number of `\n`, plus one for a last line with no newline. */
export const countLines = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

const showAt = (root: string, ref: string, path: string): string | undefined => {
  const shown = git(root, ['show', `${ref}:${path}`]);
  return shown.ok ? shown.out : undefined;
};

const readTree = (root: string, path: string): string | undefined => {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
};

const today = (): string => new Date().toISOString().slice(0, 10);

type Reader = (path: string) => string | undefined;

/** Evaluate one set of changed files with files read through `read` (a commit or the working tree). */
function judge(
  root: string,
  changed: readonly string[],
  read: Reader,
  window: ChurnWindow,
  useDeclarations: boolean,
  now: string,
): Evaluation {
  const declared = useDeclarations ? readDeclared(packageRoots(root), read).entries : [];
  const cache = new Map<string, number | undefined>();
  const lines = (file: string): number | undefined => {
    if (!cache.has(file)) {
      const text = read(file);
      cache.set(file, text === undefined ? undefined : countLines(text));
    }
    return cache.get(file);
  };
  return evaluate({ changed, lines, churn: window.counts, declared, today: now });
}

export interface RunResult {
  readonly code: number;
  readonly lines: readonly string[];
}

/** What the CI step does, given the environment One Folder's workflow passes. Never throws; every failure says why. */
export function run(root: string, env: Record<string, string | undefined>): RunResult {
  if (env.FY_ONE_FOLDER_EVENT !== 'pull_request' || env.FY_ONE_FOLDER_BASE_REF !== ONE_FOLDER_BASE_REF)
    return { code: 0, lines: [`size/churn: not a pull request into ${ONE_FOLDER_BASE_REF}; nothing to check`] };
  const base = env.FY_ONE_FOLDER_BASE_SHA ?? '';
  const head = env.FY_ONE_FOLDER_HEAD_SHA ?? '';
  const files = changedFiles(root, base, head);
  if ('error' in files)
    return {
      code: 1,
      lines: [`❌ size/churn: the changed files could not be computed (${files.error}). Re-run the job.`],
    };
  const window = churnWindow(root, base);
  const result = judge(root, files.files, path => showAt(root, head, path), window, true, today());
  return { code: result.ok ? 0 : 1, lines: describe(result, window) };
}

/** `--all`: judge every tracked source file of the working tree against the window ending at HEAD. */
export function runAll(root: string): RunResult {
  const tracked = git(root, ['ls-files', '*.ts', '*.tsx']).out.split('\n').filter(isSource);
  const window = churnWindow(root, 'HEAD');
  const result = judge(root, tracked, path => readTree(root, path), window, true, today());
  return { code: result.ok ? 0 : 1, lines: describe(result, window) };
}

// ─── replay over history (read-only) ─────────────────────────────────────────────────────────────────────────────

const names = (findings: readonly Finding[]): string =>
  findings.length === 0
    ? '-'
    : findings.map(item => `\`${item.file.replace(/^packages\//, '')}\` (${item.rule})`).join(', ');

/**
 * What the rule would have flagged on each of the last `count` merges of `ref`: judged on the PR's own diff, against the
 * window of 80 merges before it. Two columns: with NO declaration (the raw measurement) and with TODAY's declarations (what
 * a PR would face once the seed rows exist). Files are read at the merge, declarations from the working tree.
 */
export function replay(root: string, ref: string, count: number): string[] {
  const merges = git(root, ['log', '--first-parent', `-${count}`, '--format=%H%x09%s', ref])
    .out.split('\n')
    .filter(line => line !== '')
    .map(line => {
      const [sha = '', subject = ''] = line.split('\t');
      return { sha, pr: /#(\d+)/.exec(subject)?.[1] ?? '?' };
    });
  const now = today();
  const rows = [
    '| # | PR | Merge | Flagged with no declaration | Flagged with the declarations of today |',
    '|---|---|---|---|---|',
  ];
  let rawFailed = 0;
  let declaredFailed = 0;
  merges.forEach((merge, index) => {
    const parent = git(root, ['rev-parse', `${merge.sha}^1`]).out.trim();
    const changed = changedFiles(root, parent, merge.sha);
    if ('error' in changed) {
      rows.push(`| ${index + 1} | #${merge.pr} | ${merge.sha.slice(0, 10)} | (${changed.error}) | |`);
      return;
    }
    const window = churnWindow(root, parent);
    const read: Reader = path => showAt(root, merge.sha, path);
    const declaredNow: Reader = path => (path.endsWith('composition.tsv') ? readTree(root, path) : read(path));
    const raw = judge(root, changed.files, read, window, false, now);
    const withRows = judge(root, changed.files, declaredNow, window, true, now);
    if (!raw.ok) rawFailed++;
    if (!withRows.ok) declaredFailed++;
    rows.push(
      `| ${index + 1} | #${merge.pr} | ${merge.sha.slice(0, 10)} | ${names(raw.findings)} | ${names(withRows.findings)} |`,
    );
  });
  rows.push(
    '',
    `Of ${merges.length} merges: ${rawFailed} would have been flagged with no declaration, ${declaredFailed} with today's declarations ` +
      `(a file a merge grew past its ceiling, or a hot file nobody declared). The rule did not exist when they merged.`,
  );
  return rows;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--replay') {
    const [, ref = 'origin/rebuild/5.0-after', count = '40'] = argv;
    for (const line of replay(process.cwd(), ref, Number(count))) console.log(line);
    process.exit(0);
  }
  const { code, lines } = argv[0] === '--all' ? runAll(process.cwd()) : run(process.cwd(), process.env);
  for (const line of lines) console.log(line);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY ?? '/dev/null',
    `\n### Size/churn check\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`,
  );
  process.exit(code);
}
