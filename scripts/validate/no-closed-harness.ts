/**
 * The scanner behind `scripts/validate/no-closed-harness.sh` (read the header there for WHY and the ledger's shape).
 *
 * Counting is by SYNTAX over the whole file, not by line, so a union split over two lines, a double-quoted union, a
 * trailing-comma tuple and a second literal on a line that already holds one are each seen, and counted once apiece.
 *
 *   no-closed-harness.ts [--print]
 *
 * Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LEDGER = 'scripts/validate/no-closed-harness-allowlist.txt';
/** The base the ledger may not grow from when CI names none: the branch every pull request lands in. */
export const DEFAULT_BASE = 'origin/rebuild/5.0-after';

export type Kind = 'literal' | 'known' | 'branch';
/** `path::kind` to its count. */
export type Counts = ReadonlyMap<string, number>;

/** A string literal in either quote style. */
const str = (word: string): string => `(?:'${word}'|"${word}")`;
const claude = str('claude(?:-code)?');
const codex = str('codex');
const anyHarness = str('(?:claude(?:-code)?|codex)');
/** A harness-named operand: `harness`, `harnessKey`, `harnessKind`, reached through any `.`/`?.`/`[…]`. */
const name = '[A-Za-z_.?]*[Hh]arness(?:Key|Kind)?[\\]?]*';
const eq = '(?:===?|!==?)';
const gap = '\\s*';

/** Every pattern is global and runs over the whole text, so `\s*` crosses a line break. */
const PATTERNS: Readonly<Record<Kind, readonly RegExp[]>> = {
  literal: [
    new RegExp(`${claude}${gap}\\|${gap}${codex}`, 'g'),
    new RegExp(`${codex}${gap}\\|${gap}${claude}`, 'g'),
    new RegExp(`\\[${gap}${claude}${gap},${gap}${codex}${gap},?${gap}\\]`, 'g'),
    new RegExp(`\\[${gap}${codex}${gap},${gap}${claude}${gap},?${gap}\\]`, 'g'),
  ],
  known: [/KnownHarnessKey|isKnownHarnessKey|KNOWN_HARNESS_KEYS/g],
  branch: [
    new RegExp(`${name}${gap}${eq}${gap}${anyHarness}`, 'g'),
    new RegExp(`${anyHarness}${gap}${eq}${gap}${name}`, 'g'),
  ],
};

/** The number of closed-set uses of each kind in one file's text. */
export const countKinds = (text: string): ReadonlyMap<Kind, number> => {
  const found = new Map<Kind, number>();
  for (const kind of Object.keys(PATTERNS) as Kind[]) {
    let n = 0;
    for (const pattern of PATTERNS[kind]) n += [...text.matchAll(pattern)].length;
    if (n > 0) found.set(kind, n);
  }
  return found;
};

/** Where a closed set is allowed: tests, the two harness plugins and the file that declares the shipped keys. */
export const inScope = (path: string): boolean =>
  /^packages\/.*\.tsx?$/.test(path) &&
  !/^packages\/[^/]+(\/[^/]+)*\/tests\//.test(path) &&
  !path.startsWith('packages/plugins/claude-code/') &&
  !path.startsWith('packages/plugins/codex/') &&
  path !== 'packages/core/ferrets/contract/ids.ts';

const git = (root: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync('git', [...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** The closed-set counts of every tracked product file in the working tree. */
export const scanTree = (root: string): Counts => {
  const listed = git(root, ['ls-files', '-z', '--', 'packages']);
  if (listed.status !== 0) throw new Error(`git ls-files failed (exit ${listed.status}): ${listed.stderr}`);
  const counts = new Map<string, number>();
  for (const path of listed.stdout.split('\0')) {
    if (path === '' || !inScope(path) || !existsSync(join(root, path))) continue;
    for (const [kind, n] of countKinds(readFileSync(join(root, path), 'utf8'))) counts.set(`${path}::${kind}`, n);
  }
  return counts;
};

/** A ledger's rows, `path::kind=N  # part` with comments and blank lines dropped. */
export const parseLedger = (text: string): Counts => {
  const rows = new Map<string, number>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s*#.*$/, '').trim();
    if (line === '') continue;
    const at = line.lastIndexOf('=');
    rows.set(line.slice(0, at), Number(line.slice(at + 1)));
  }
  return rows;
};

const rowText = (counts: Counts): string[] => [...counts].map(([key, n]) => `${key}=${n}`).sort();

/** `<` rows are in the ledger and not the code, `>` rows are in the code and not the ledger (exact both ways). */
export const diffExact = (ledger: Counts, actual: Counts): string[] => {
  const listed = new Set(rowText(ledger));
  const present = new Set(rowText(actual));
  return [
    ...[...listed].filter(row => !present.has(row)).map(row => `< ${row}`),
    ...[...present].filter(row => !listed.has(row)).map(row => `> ${row}`),
  ];
};

/** The ratchet: a row the base ledger does not hold, or holds at a lower count, is growth. */
export const growth = (ledger: Counts, base: Counts): string[] =>
  [...ledger]
    .filter(([key, n]) => n > (base.get(key) ?? 0))
    .map(
      ([key, n]) =>
        `+ ${key}=${n}${base.has(key) ? ` (the base holds ${base.get(key)})` : ' (the base holds no such row)'}`,
    )
    .sort();

export type Base =
  | { readonly ref: string; readonly ledger: Counts | null }
  | { readonly ref: string; readonly unreadable: true };

/** The ledger at the base ref. `ledger: null` is the bootstrap (the base predates the ledger); unreadable is a broken gate. */
export const readBase = (root: string, ref: string): Base => {
  if (git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status !== 0) return { ref, unreadable: true };
  const shown = git(root, ['show', `${ref}:${LEDGER}`]);
  return { ref, ledger: shown.status === 0 ? parseLedger(shown.stdout) : null };
};

export const run = (
  root: string,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): number => {
  const ledgerPath = join(root, LEDGER);
  if (!existsSync(ledgerPath)) {
    console.error(`❌ missing ledger: ${LEDGER}`);
    return 2;
  }
  const actual = scanTree(root);
  if (argv.includes('--print')) {
    for (const row of rowText(actual)) console.log(row);
    return 0;
  }
  const ledger = parseLedger(readFileSync(ledgerPath, 'utf8'));
  let failed = false;

  const delta = diffExact(ledger, actual);
  if (delta.length > 0) {
    failed = true;
    console.error(`❌ a closed harness set outside the two harness plugins differs from its ledger (${LEDGER}).`);
    console.error(
      "   '<' is the ledger, '>' is the code. A '>' row is a NEW (or more) closed use: read the harness through HarnessKey",
    );
    console.error(
      "   and harnessFacts(key), and refuse a key you do not know with the shared refusal. A '<' row is a part that is now",
    );
    console.error('   clean or lower: delete or lower its row.');
    for (const row of delta) console.error(row);
  }

  // THE RATCHET. The exact check above holds the ledger to the tree; this holds the ledger to the BASE, so a new offender
  // cannot be blessed by adding its own row. CI names the base (FY_CHECK_BASE, scripts/ci/check-base.sh); locally it is the
  // branch pull requests land in. A base with no ledger is the bootstrap (the change that introduces it). A base that
  // cannot be read FAILS: it is never skipped.
  const base = readBase(root, env.FY_CHECK_BASE || DEFAULT_BASE);
  if ('unreadable' in base) {
    console.error(
      `❌ cannot read the base ${base.ref} to hold ${LEDGER} to its shrink-only ratchet (fetch it, or set FY_CHECK_BASE)`,
    );
    return 2;
  }
  if (base.ledger !== null) {
    const grown = growth(ledger, base.ledger);
    if (grown.length > 0) {
      failed = true;
      console.error(`❌ ${LEDGER} grew against ${base.ref}: a row never gets added and a count never goes up.`);
      console.error(
        '   Read the harness through HarnessKey and harnessFacts(key) and refuse a key you do not know instead.',
      );
      for (const row of grown) console.error(row);
    }
  }
  return failed ? 1 : 0;
};

if (import.meta.main) {
  const root = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd();
  process.exit(run(root, process.argv.slice(2), process.env));
}
