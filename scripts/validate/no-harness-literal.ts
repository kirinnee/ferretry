/**
 * The scanner behind `scripts/validate/no-harness-literal.sh` (read the header there for WHY and the list's shape).
 *
 *   no-harness-literal.ts [--print]
 *
 * Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCANNER = 'scripts/validate/no-harness-literal.ts';
export const LEDGER = 'scripts/validate/no-harness-literal-remaining.txt';
/** The base the list may not grow from when CI names none: the branch every pull request lands in. */
export const DEFAULT_BASE = 'origin/rebuild/5.0-after';

/** The tree the rule is about. */
export const SCOPE = 'packages/plugins/runtimes/daemon/';

/** The four files that may spell a harness's stored word: the word table, and the three stored file shapes. */
export const SPELLING_FILES: ReadonlySet<string> = new Set([
  `${SCOPE}lib/harness-kind.ts`,
  `${SCOPE}lib/account/schema.ts`,
  `${SCOPE}lib/account/halves.ts`,
  `${SCOPE}lib/config.ts`,
]);

/** `path` to its count. */
export type Counts = ReadonlyMap<string, number>;

/**
 * THE PIN: the only rows the list may ever hold, with the highest count each may have. They are the four files whose literals
 * E-276 PR 17b moves (each needs a kit member AND the frozen goldens' setup threaded with the real kits), approved when the close-out
 * was split. The list may lower a count or delete a row; it may never add a row or raise a count past this pin, whatever the code
 * holds and whatever the base ref says (a base that predates the list, or a base that was itself loosened, pins nothing). Editing
 * this constant is a change to the gate itself and is reviewed as one.
 */
export const PINNED: Counts = new Map([
  [`${SCOPE}lib/account/builtin-autonomous.ts`, 2],
  [`${SCOPE}lib/account/layering.ts`, 2],
  [`${SCOPE}lib/account/scope.ts`, 4],
  [`${SCOPE}lib/service/foreign.ts`, 2],
]);

const HARNESS_WORDS: ReadonlySet<string> = new Set(['claude', 'codex']);

/** What may stand before a `/` for it to open a regular expression rather than divide. */
const BEFORE_REGEX = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

/**
 * How many string literals of `text` are exactly `claude` or `codex`, read the way TypeScript reads them: comments are skipped,
 * a quoted string is read to its closing quote (an escape skips one character), a regular expression is skipped whole, and a
 * template literal is read as its text AND its `${ ... }` code, nested to any depth, so a literal inside an interpolation (or a
 * template inside one) counts like any other. A template with no placeholder counts when its whole text is the word.
 */
export const countLiterals = (text: string): number => {
  let count = 0;
  let at = 0;
  let last = '';
  /** One entry per open `{` of code: `'template'` when it is a `${` that returns to its template text on its `}`. */
  const braces: ('block' | 'template')[] = [];
  /** Every template being read, innermost last: where it opens and whether it has a placeholder yet. */
  const templateStarts: { readonly at: number; placeholder: boolean }[] = [];

  /** Reads template text from `at` to its closing backtick or its next `${` (which returns to code). */
  const readTemplateText = (): void => {
    const open = templateStarts[templateStarts.length - 1] as { readonly at: number; placeholder: boolean };
    while (at < text.length) {
      const char = text[at];
      if (char === '\\') at += 2;
      else if (char === '`') {
        if (!open.placeholder && HARNESS_WORDS.has(text.slice(open.at + 1, at))) count++;
        templateStarts.pop();
        at++;
        last = '`';
        return;
      } else if (char === '$' && text[at + 1] === '{') {
        open.placeholder = true;
        braces.push('template');
        at += 2;
        last = '{';
        return;
      } else at++;
    }
  };

  while (at < text.length) {
    const char = text[at] as string;
    const next = text[at + 1];
    if (char === '/' && next === '/') {
      while (at < text.length && text[at] !== '\n') at++;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', at + 2);
      at = end < 0 ? text.length : end + 2;
    } else if (char === '/' && (last === '' || BEFORE_REGEX.has(last))) {
      let inClass = false;
      at++;
      while (at < text.length && text[at] !== '\n' && (inClass || text[at] !== '/')) {
        if (text[at] === '\\') at++;
        else if (text[at] === '[') inClass = true;
        else if (text[at] === ']') inClass = false;
        at++;
      }
      at++;
      last = '/';
    } else if (char === "'" || char === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== char) {
        if (text[end] === '\\') end++;
        else if (text[end] === '\n') break;
        end++;
      }
      if (HARNESS_WORDS.has(text.slice(at + 1, end))) count++;
      at = end + 1;
      last = char;
    } else if (char === '`') {
      templateStarts.push({ at, placeholder: false });
      at++;
      readTemplateText();
    } else if (char === '{') {
      braces.push('block');
      at++;
      last = '{';
    } else if (char === '}') {
      at++;
      last = '}';
      if (braces.pop() === 'template') readTemplateText();
    } else {
      if (!/\s/u.test(char)) last = char;
      at++;
    }
  }
  return count;
};

/** Whether `path` is a source file the rule reads. */
export const inScope = (path: string): boolean =>
  path.startsWith(SCOPE) && /\.tsx?$/u.test(path) && !SPELLING_FILES.has(path);

const git = (root: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync('git', [...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** The literal counts of every tracked or new, not ignored, source file of the tree. */
export const scanTree = (root: string): Counts => {
  const listed = git(root, ['ls-files', '-co', '--exclude-standard', '-z', '--', SCOPE]);
  if (listed.status !== 0) throw new Error(`git ls-files failed (exit ${listed.status}): ${listed.stderr}`);
  const counts = new Map<string, number>();
  for (const path of new Set(listed.stdout.split('\0'))) {
    if (path === '' || !inScope(path) || !existsSync(join(root, path))) continue;
    const n = countLiterals(readFileSync(join(root, path), 'utf8'));
    if (n > 0) counts.set(path, n);
  }
  return counts;
};

/** A list's rows, `path::N  # why` with comments and blank lines dropped. */
export const parseLedger = (text: string): Counts => {
  const rows = new Map<string, number>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s*#.*$/, '').trim();
    if (line === '') continue;
    const at = line.lastIndexOf('::');
    rows.set(line.slice(0, at), Number(line.slice(at + 2)));
  }
  return rows;
};

const rowText = (counts: Counts): string[] => [...counts].map(([key, n]) => `${key}::${n}`).sort();

/** `<` rows are in the list and not the code, `>` rows are in the code and not the list (exact both ways). */
export const diffExact = (ledger: Counts, actual: Counts): string[] => {
  const listed = new Set(rowText(ledger));
  const present = new Set(rowText(actual));
  return [
    ...[...listed].filter(row => !present.has(row)).map(row => `< ${row}`),
    ...[...present].filter(row => !listed.has(row)).map(row => `> ${row}`),
  ];
};

/** The ratchet: a row the base list does not hold, or holds at a lower count, is growth. */
export const growth = (ledger: Counts, base: Counts, holds = 'the base holds'): string[] =>
  [...ledger]
    .filter(([key, n]) => n > (base.get(key) ?? 0))
    .map(([key, n]) => `+ ${key}::${n}${base.has(key) ? ` (${holds} ${base.get(key)})` : ` (${holds} no such row)`}`)
    .sort();

export type Base =
  | { readonly ref: string; readonly ledger: Counts | null }
  | { readonly ref: string; readonly unreadable: true };

/** The list at the base ref. `ledger: null` is the bootstrap (the base predates the list); unreadable is a broken gate. */
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
    console.error(`❌ missing list: ${LEDGER}`);
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
    console.error(`❌ a harness literal ('claude' or 'codex') in Runtimes' daemon differs from its list (${LEDGER}).`);
    console.error(
      "   '<' is the list, '>' is the code. A '>' row is a NEW (or more) literal: what a harness does inside Runtimes is its",
    );
    console.error(
      "   plugin's kit (packages/plugins/runtimes/contract/harness-kit.ts), found by the harness the runtime is for.",
    );
    console.error("   A '<' row is a file that is now clean or lower: delete or lower its row.");
    for (const row of delta) console.error(row);
  }

  const beyondPin = growth(ledger, PINNED, 'the pin holds');
  if (beyondPin.length > 0) {
    failed = true;
    console.error(
      `❌ ${LEDGER} holds more than the pinned four rows of E-276 PR 17b (PINNED in ${SCANNER}): a row is never added and a count never goes up, even when the code matches it.`,
    );
    for (const row of beyondPin) console.error(row);
  }

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
      for (const row of grown) console.error(row);
    }
  }
  return failed ? 1 : 0;
};

if (import.meta.main) {
  const root = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd();
  process.exit(run(root, process.argv.slice(2), process.env));
}
