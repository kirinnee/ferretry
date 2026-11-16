/**
 * THE COMPOSITION GUARD of a pull request into `rebuild/5.0-after`: a feature adds files and lines, it never rewrites
 * shared code (docs/standards/architecture "A feature adds files and lines; it never rewrites shared code").
 *
 * Every package declares its composition files (the few hand-written seams: a manifest literal, a wiring `index.ts`, a big
 * service class, a contract barrel) and its registries in `<package>/composition.tsv` (read by `lib/composition.ts`). A PR
 * that edits one of them FAILS unless its body has a `## Contract change` section naming that file, with a reason:
 *
 *     ## Contract change
 *     - packages/core/ferrets/contract/port.ts: new `restart` member of FerretsApi
 *
 *   1. The declarations are read at the PR's MERGE-BASE, so a PR cannot un-declare a file and edit it in one go.
 *   2. The PR's own diff is `git diff <base>...<head>` (merge-base), the same range One Folder reads.
 *   3. EXEMPT, because they are what a registry is for: a pure one-line ADD to a `registry` file (one added line, zero
 *      removed, in its sorted place among its entries); any edit of a `composition.tsv` that only ADDS lines (a package, or a
 *      new package, declaring more files only tightens this guard; order is held by the `composition` check, and a removed or
 *      changed declaration is not exempt); and line DELETIONS from a `ports-pending.json` ledger (closing a ruled line is expected).
 *   4. Anything that cannot be decided (no sha, no merge-base, an unreadable `composition.tsv`) FAILS and says why.
 *   5. Generated files are never on the list: a hand edit of one already fails `registries.ts --check`.
 *
 * `evaluate` is pure; the git, file-system and environment reads are below it. It shares the body parser, the reason rule
 * and the package roots with One Folder (`one-folder.ts`) and runs as a step of the same job.
 *
 *   bun scripts/ci/composition-guard.ts --replay <ref> [count] [bodies.json]
 *     reads (never writes) the last `count` first-parent merges of <ref>, finds each merge's PR body (from `bodies.json`,
 *     `{ "<pr number>": "<body>" }`, else `gh pr view <n> --json body`), and prints which ones the rule would have failed.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { changedFiles, git } from './changed-files.ts';
import { COMPOSITION_FILE, type CompositionEntry, guarded, readDeclared } from './lib/composition.ts';
import { ONE_FOLDER_BASE_REF, hasReason, packageRoots, sectionEntries } from './one-folder.ts';

/** The ledgers whose pure line deletions are exempt. */
const LEDGER = 'ports-pending.json';

/** What one declared file's diff says: the lines added and removed, and where the first added line sits in the head. */
export interface FileChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** 1-based line of the first added line in the head version (0 when nothing was added). */
  readonly addedAt: number;
  /** The head version's lines; undefined when the file was deleted. */
  readonly head: readonly string[] | undefined;
}

export type Exemption = 'registry-add' | 'declaration-add' | 'ledger-closing';

export interface Guarded {
  readonly file: string;
  readonly kind: CompositionEntry['kind'] | 'declaration';
  readonly owner: string;
}

export interface Evaluation {
  readonly ok: boolean;
  /** Declared files this PR edits, whatever the verdict for each. */
  readonly edited: readonly Guarded[];
  readonly exempt: readonly { readonly file: string; readonly why: Exemption }[];
  /** Edited, not exempt, and named under `## Contract change` with a reason. */
  readonly explained: readonly string[];
  /** Edited, not exempt, and not explained. */
  readonly missing: readonly Guarded[];
  readonly hasSection: boolean;
  /** Section entries that have no reason, or name a file this PR does not edit as a composition file. */
  readonly badEntries: readonly string[];
  readonly problems: readonly string[];
}

const indentOf = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? '';

/** The sort key of one line of a guarded file: a `composition.tsv` is sorted by path then kind, everything else by its text. */
const keyOf = (file: string, line: string): string => {
  if (basename(file) !== COMPOSITION_FILE) return line.trim();
  const cells = line.split('\t');
  return `${cells[1] ?? ''}\t${cells[0] ?? ''}`;
};

/**
 * Whether the diff of a registry is one added line in its sorted place: exactly one added line, nothing removed, and the
 * line sits strictly between the nearest entries of its own shape above and below it (same indentation, so an opener
 * like `export default [` or a closer is not an entry; a `composition.tsv` header is skipped). Total.
 */
export function isSortedAdd(file: string, change: FileChange): boolean {
  if (change.added.length !== 1 || change.removed.length !== 0 || change.head === undefined) return false;
  const lines = change.head;
  const at = change.addedAt - 1;
  const line = lines[at];
  if (line === undefined || line !== change.added[0] || line.trim() === '') return false;
  const tsv = basename(file) === COMPOSITION_FILE;
  const indent = indentOf(line);
  const entry = (candidate: string | undefined, index: number): candidate is string =>
    candidate !== undefined && candidate.trim() !== '' && indentOf(candidate) === indent && !(tsv && index === 0);
  const key = keyOf(file, line);
  for (let index = at - 1; index >= 0; index--) {
    const above = lines[index];
    if (entry(above, index)) {
      if (!(keyOf(file, above) < key)) return false;
      break;
    }
  }
  for (let index = at + 1; index < lines.length; index++) {
    const below = lines[index];
    if (entry(below, index)) {
      if (!(key < keyOf(file, below))) return false;
      break;
    }
  }
  return true;
}

/**
 * A ledger edit that only closes lines: nothing added, or only the comma the new last entry now lacks (a removed line comes
 * back without its trailing comma), and strictly more lines removed than added.
 */
export function isLedgerClosing(change: FileChange): boolean {
  if (change.removed.length <= change.added.length) return false;
  const removed = new Set(change.removed);
  return change.added.every(line => removed.has(`${line},`));
}

const exemption = (file: string, entry: CompositionEntry | undefined, change: FileChange): Exemption | undefined => {
  if (basename(file) === LEDGER && isLedgerClosing(change)) return 'ledger-closing';
  if (basename(file) === COMPOSITION_FILE && change.removed.length === 0 && change.added.length > 0)
    return 'declaration-add';
  if (entry?.kind === 'registry' && isSortedAdd(file, change)) return 'registry-add';
  return undefined;
};

export interface EvaluateInput {
  /** The declared compositions and registries, read at the PR's merge-base. */
  readonly declared: ReadonlyMap<string, CompositionEntry>;
  /** Per edited file (declared or not): its diff. Only declared files and `composition.tsv` files are looked at. */
  readonly changes: ReadonlyMap<string, FileChange>;
  readonly body: string;
  /** Things that stopped the declarations from being read. */
  readonly problems?: readonly string[];
}

export function evaluate(input: EvaluateInput): Evaluation {
  const edited: Guarded[] = [];
  const exempt: { file: string; why: Exemption }[] = [];
  const need: Guarded[] = [];
  for (const [file, change] of input.changes) {
    const entry = input.declared.get(file);
    const declaration = basename(file) === COMPOSITION_FILE;
    if (entry === undefined && !declaration) continue;
    const owner = file.endsWith(`/${COMPOSITION_FILE}`) ? file.slice(0, -COMPOSITION_FILE.length - 1) : '';
    const item: Guarded = { file, kind: entry?.kind ?? 'declaration', owner: entry?.owner ?? owner };
    edited.push(item);
    const why = exemption(file, entry, change);
    if (why === undefined) need.push(item);
    else exempt.push({ file, why });
  }

  const entries = sectionEntries(input.body, 'Contract change');
  const reasoned = (entries ?? []).filter(entry => hasReason(entry.reason));
  const explained: string[] = [];
  const missing: Guarded[] = [];
  for (const item of need) {
    if (reasoned.some(entry => entry.pattern.replace(/^\.\//, '') === item.file)) explained.push(item.file);
    else missing.push(item);
  }
  // Said, not failed on: an entry with no reason explains nothing, so the file it was meant for is in `missing` anyway.
  const badEntries = (entries ?? []).flatMap(entry =>
    hasReason(entry.reason) ? [] : [`"${entry.pattern}" has no reason after it`],
  );
  const problems = input.problems ?? [];
  return {
    ok: missing.length === 0 && problems.length === 0,
    edited,
    exempt,
    explained,
    missing,
    hasSection: entries !== undefined,
    badEntries,
    problems,
  };
}

/** The owner-readable report: which declared file, and exactly what to add to the PR body. */
export function describe(result: Evaluation): string[] {
  const out: string[] = ['Composition guard: a feature adds files and lines; it never rewrites shared code'];
  for (const problem of result.problems) out.push(`❌ ${problem}`);
  for (const { file, why } of result.exempt)
    out.push(
      `  exempt ${file}: ${
        why === 'registry-add'
          ? 'one line added in its sorted place'
          : why === 'declaration-add'
            ? 'declarations added'
            : 'ledger lines closed'
      }`,
    );
  for (const file of result.explained) out.push(`  ✓ ${file} (named under "## Contract change")`);
  if (result.missing.length > 0) {
    out.push(
      `❌ This PR edits ${result.missing.length} composition file${result.missing.length === 1 ? '' : 's'}` +
        ` (declared in a composition.tsv) without saying why. A feature adds files and lines; a real contract change` +
        ` edits the contract and says so:`,
    );
    for (const { file, kind, owner } of result.missing)
      out.push(
        `  ✗ ${file}  (${kind === 'declaration' ? 'a composition.tsv' : `${kind} of ${owner === '' ? 'the repository root' : owner}`})`,
      );
    out.push(
      result.hasSection
        ? 'Add each file to the "## Contract change" section of the PR body, with a one-line reason:'
        : 'Add a section to the PR body naming each file by its full path, with a one-line reason:',
    );
    out.push('  ## Contract change');
    for (const { file } of result.missing) out.push(`  - ${file}: why this PR has to change it`);
    out.push(
      'If the change is only one new line in a registry, put it in its sorted place; that needs no section. Behaviour goes in the feature folder.',
    );
  }
  for (const bad of result.badEntries) out.push(`❌ In "## Contract change": ${bad}.`);
  if (result.ok)
    out.push(
      result.edited.length === 0
        ? '✅ No composition file is edited.'
        : '✅ Every edited composition file is exempt or explained.',
    );
  return out;
}

// ─── reading the repository ──────────────────────────────────────────────────────────────────────────────────────

/** `@@ -a,b +c,d @@` → the first added line in the head (c), or 0 when the hunk adds none (d = 0). */
const hunkStart = (header: string): number => {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (match === null) return 0;
  return match[2] === '0' ? 0 : Number(match[1]);
};

/** `git diff -U0` text → per file its added and removed lines. Pure; the head text is filled in later. */
export function parseDiff(
  text: string,
): ReadonlyMap<string, { added: string[]; removed: string[]; addedAt: number; deleted: boolean }> {
  const files = new Map<string, { added: string[]; removed: string[]; addedAt: number; deleted: boolean }>();
  let current: { added: string[]; removed: string[]; addedAt: number; deleted: boolean } | undefined;
  let cursor = 0;
  for (const line of text.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header !== null) {
      current = { added: [], removed: [], addedAt: 0, deleted: false };
      files.set(header[2] as string, current);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('deleted file mode')) current.deleted = true;
    else if (line.startsWith('@@')) cursor = hunkStart(line);
    else if (line.startsWith('+') && !line.startsWith('+++')) {
      if (current.added.length === 0) current.addedAt = cursor;
      current.added.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) current.removed.push(line.slice(1));
  }
  return files;
}

const showAt = (root: string, ref: string, path: string): string | undefined => {
  const run = git(root, ['show', `${ref}:${path}`]);
  return run.ok ? run.out : undefined;
};

export interface Decision {
  readonly evaluation: Evaluation;
  readonly declaredCount: number;
}

/**
 * The PR's verdict over the range `base...head`, the declarations read through `readDeclaration` (the merge-base for a PR;
 * the tip for the replay). Never throws: what cannot be read is a `problem`, which fails.
 */
export function decide(
  root: string,
  base: string,
  head: string,
  body: string,
  readDeclaration: (path: string) => string | undefined,
): Decision {
  const problems: string[] = [];
  const declared = readDeclared(packageRoots(root), readDeclaration);
  for (const problem of declared.problems) problems.push(`${problem.where}: ${problem.message}`);
  const guardedMap = guarded(declared.entries);
  const files = changedFiles(root, base, head);
  if ('error' in files) {
    problems.push(`the changed files could not be computed (${files.error}). Re-run the job.`);
    return {
      evaluation: evaluate({ declared: guardedMap, changes: new Map(), body, problems }),
      declaredCount: guardedMap.size,
    };
  }
  const watched = files.files.filter(file => guardedMap.has(file) || basename(file) === COMPOSITION_FILE);
  const changes = new Map<string, FileChange>();
  if (watched.length > 0) {
    const diff = git(root, ['diff', '-U0', '--no-color', '--no-renames', `${base}...${head}`, '--', ...watched]);
    if (!diff.ok) problems.push(`git diff ${base}...${head} failed. Re-run the job.`);
    for (const [file, parsed] of parseDiff(diff.out)) {
      const text = parsed.deleted ? undefined : showAt(root, head, file);
      changes.set(file, {
        added: parsed.added,
        removed: parsed.removed,
        addedAt: parsed.addedAt,
        head: text === undefined ? undefined : text.split('\n'),
      });
    }
  }
  return { evaluation: evaluate({ declared: guardedMap, changes, body, problems }), declaredCount: guardedMap.size };
}

export interface RunResult {
  readonly code: number;
  readonly lines: readonly string[];
}

/** What the job does, given the environment One Folder passes. Never throws; every failure is an exit 1 that says why. */
export function run(root: string, env: Record<string, string | undefined>): RunResult {
  if (env.FY_ONE_FOLDER_EVENT !== 'pull_request' || env.FY_ONE_FOLDER_BASE_REF !== ONE_FOLDER_BASE_REF)
    return { code: 0, lines: [`composition guard: not a pull request into ${ONE_FOLDER_BASE_REF}; nothing to check`] };
  const base = env.FY_ONE_FOLDER_BASE_SHA ?? '';
  const head = env.FY_ONE_FOLDER_HEAD_SHA ?? '';
  const mergeBase = git(root, ['merge-base', base, head]).out.trim();
  if (mergeBase === '')
    return {
      code: 1,
      lines: [`❌ composition guard: no merge-base of ${base} and ${head} in this checkout. Re-run the job.`],
    };
  const { evaluation } = decide(root, base, head, env.FY_ONE_FOLDER_PR_BODY ?? '', path =>
    showAt(root, mergeBase, path),
  );
  return { code: evaluation.ok ? 0 : 1, lines: describe(evaluation) };
}

// ─── replay over history (read-only) ─────────────────────────────────────────────────────────────────────────────

/** The first-parent merges of a ref, newest first: `{ sha, pr }` where the subject names a pull request. */
function firstParentMerges(root: string, ref: string, count: number): { sha: string; pr: string; subject: string }[] {
  const log = git(root, ['log', '--first-parent', '--merges', `-${count}`, '--format=%H%x09%s', ref]);
  return log.out
    .split('\n')
    .filter(line => line !== '')
    .map(line => {
      const [sha = '', subject = ''] = line.split('\t');
      return { sha, subject, pr: /#(\d+)/.exec(subject)?.[1] ?? '' };
    });
}

function replay(root: string, ref: string, count: number, bodiesFile: string | undefined): string[] {
  const bodies: Record<string, string> =
    bodiesFile !== undefined && existsSync(bodiesFile) ? JSON.parse(readFileSync(bodiesFile, 'utf8')) : {};
  const rows: string[] = [
    '| # | PR | Merge | Verdict | Declared files edited | Needs a `## Contract change` for |',
    '|---|---|---|---|---|---|',
  ];
  const merges = firstParentMerges(root, ref, count);
  let failed = 0;
  merges.forEach((merge, index) => {
    const body = bodies[merge.pr] ?? ghBody(root, merge.pr);
    const parent = git(root, ['rev-parse', `${merge.sha}^1`]).out.trim();
    const { evaluation } = decide(root, parent, merge.sha, body, path => safeRead(root, path));
    if (!evaluation.ok) failed++;
    const short = (list: readonly string[]): string =>
      list.length === 0 ? '-' : list.map(file => `\`${file.replace(/^packages\//, '')}\``).join(', ');
    rows.push(
      `| ${index + 1} | #${merge.pr || '?'} | ${merge.sha.slice(0, 10)} | ${evaluation.ok ? 'pass' : '**FAIL**'} | ${short(evaluation.edited.map(item => item.file))} | ${short(evaluation.missing.map(item => item.file))}${evaluation.problems.length > 0 ? ` (problem: ${evaluation.problems.join('; ')})` : ''} |`,
    );
  });
  rows.push(
    '',
    `${failed} of ${merges.length} merges would have failed. The rule did not exist when they merged, so none of them carried a "## Contract change" section unless its body shows one.`,
  );
  return rows;
}

const safeRead = (root: string, path: string): string | undefined => {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
};

/** A PR body from GitHub, read-only; empty when it cannot be read (the row then reads as if the PR said nothing). */
function ghBody(root: string, pr: string): string {
  if (pr === '') return '';
  const run = Bun.spawnSync(['gh', 'pr', 'view', pr, '--json', 'body', '--jq', '.body'], { cwd: root });
  return run.exitCode === 0 ? run.stdout.toString() : '';
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--replay') {
    const [, ref = 'origin/rebuild/5.0-after', count = '40', bodies] = argv;
    for (const line of replay(process.cwd(), ref, Number(count), bodies)) console.log(line);
    process.exit(0);
  }
  const { code, lines } = run(process.cwd(), process.env);
  for (const line of lines) console.log(line);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY ?? '/dev/null',
    `\n### Composition guard\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`,
  );
  process.exit(code);
}
