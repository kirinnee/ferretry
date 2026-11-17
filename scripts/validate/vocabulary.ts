/**
 * `vocabulary` (O18, owner !A539): the words an owner or an agent READS say the Ferretry word, not the one it replaced.
 * It is the scan test behind the "instead of" words that `glossary` hands to it (`RATCHETED_WORDS`: today `card`, whose
 * word is `task`). `glossary` reads manifest text only; this reads every place a sentence reaches a person or an agent.
 *
 * Scanned (a hit is one whole-word `card`/`cards`, case-insensitive; `-` is a word break, `_` and digits are not):
 *  - product TypeScript and TSX (every workspace package outside its tests and generated output, plus `scripts/` and
 *    `migration/`): JSX text, every string or template literal that holds whitespace (a sentence: UI, CLI output,
 *    refusals, prompts, tool descriptions), and a one-word string that is an owner text by position (a `title`,
 *    `label`, `summary`, `help`, `placeholder` or `hint` property, a `.describe()` argument, an `aria-label`);
 *  - `docs/**` (history folders aside), root `README.md`, `INSTALLATION.md` and `CLAUDE.md`, every package's
 *    `README.md` and `instructions/**`, `.claude/skills/**`.
 * Not scanned (step 2 renames them, never a sentence): comments, identifiers, whitespace-free strings, CSS, tests.
 *
 * A ratchet, not a ban, and DELETION-ONLY: each scope (a workspace package, or `docs`, `scripts`, `migration`, `.claude`,
 * the root) keeps a `vocabulary-pending/` folder with ONE FILE PER REMAINING HIT, so two branches that each fix a hit
 * delete different files and merge clean (a per-scope count both of them lower would conflict). A hit's file is
 * `<name>-<hash>.txt`: `<hash>` is eight hex digits of the hit's line with the old and new word masked and spaces
 * collapsed (the path is NOT in it, so moving a file changes nothing); `__2`, `__3` after it tell identical lines apart.
 * The body is the file and the line, for people. The check fails when
 *  - a hit has no file (new text says the old word; say the new one; or the line it sits on was edited and still has it),
 *  - a file has no hit (it was fixed: `git rm` the file; the message names the file),
 *  - the folder holds a file the base ref's folder does not (a base that holds no folder or count at all is the
 *    introduction of the ratchet, and is not compared; a base with the old count file only caps the number of files).
 * A scope with hits and no folder has a pending count of zero. The last O18 unit empties `RATCHETED_WORDS`; the
 * word is then as strict as every other.
 *
 * Exceptions, each with its reason, and nothing broader:
 *  - exact phrases: `glossary.PHRASE_EXCEPTIONS` (a payment instrument is not a piece of work);
 *  - `OLD_SPELLINGS`: a constant, by `file#NAME`, whose text deliberately keeps an old spelling for the one place
 *    that still has to read it (the hidden CLI alias, the old route keys, the old fence);
 *  - `vocabulary-allowlist.tsv`: `token<TAB>reason<TAB>until`, a whitespace-free token a sentence quotes (a stored
 *    path, a stored ref prefix). Token-keyed, so it survives edits. `until` is `step2` (goes with the rename of
 *    identifiers) or `stored` (a name on disk that is never renamed). A token no scanned text holds is a finding.
 *  - history, by folder: `HISTORY_FOLDERS`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { type AstNode, type Check, type Finding, parseFile, runMain, walk } from '../gen/lib/check.ts';
import { areaOf } from '../gen/lib/imports.ts';
import { NOT_SEARCHED, NOT_SEARCHED_PATHS } from '../gen/lib/pending-files.ts';
import { type Workspace, loadWorkspace, sourceFiles } from '../gen/lib/workspace.ts';
import { RATCHETED_WORDS, withoutExceptions } from './glossary.ts';

export const PENDING_NAME = 'vocabulary-pending';
/** The retired `{ "format": 1, "count": N }` file; a base ref may still hold it, a working tree may not. */
const LEGACY_NAME = 'vocabulary-pending.json';
export const ALLOWLIST_FILE = 'scripts/validate/vocabulary-allowlist.tsv';
export const ALLOWLIST_UNTIL: readonly string[] = ['step2', 'stored'];

/** Folders (and one root file pattern) that are history: they record what was said then. path prefix or regex → reason. */
export const HISTORY_FOLDERS: ReadonlyMap<string, string> = new Map([
  ['Changelog', 'the release record: it says what each release called things then'],
  ['docs/rebuild/', 'the rebuild log: decisions and parity rows quote the names of their day'],
  ['docs/design/', 'design records: they quote the names of the design they decided'],
  ['docs/migration/', 'the v4 to v5 import record: it quotes v4 names'],
  ['handover.md', 'the hand-over backlog: a dated record'],
]);

/**
 * Constants whose text deliberately keeps an old spelling, by `file#NAME`, each with a reason. Empty until a unit
 * keeps one (the hidden CLI alias, an old route key, the old fence). Name such a constant `oldSpelling` or
 * `formerPath`: `no-compat` bans the other words.
 */
export const OLD_SPELLINGS: ReadonlyMap<string, string> = new Map();

const OWNER_KEYS = new Set(['title', 'label', 'summary', 'help', 'placeholder', 'hint']);
const OWNER_ATTRS = new Set(['title', 'aria-label', 'aria-description', 'placeholder', 'alt', 'label']);
const NOT_TEXT_ATTRS = new Set([
  'className',
  'class',
  'id',
  'key',
  'style',
  'href',
  'to',
  'src',
  'name',
  'role',
  'type',
  'htmlFor',
  'd',
  'viewBox',
  'target',
  'rel',
  'ref',
  'as',
]);
const CLASS_HELPERS = new Set(['cn', 'clsx', 'classNames', 'cx', 'twMerge']);
const SKIPPED_SEGMENTS = new Set([
  'tests',
  'testing',
  'fixtures',
  '__fixtures__',
  'node_modules',
  'generated',
  'vendor',
  // A frozen v4 reader (the one-time importer's `src/v4/`): vendored verbatim ("do not edit; re-vendor"), it quotes
  // v4's own sentences and never speaks to the owner.
  'v4',
  '.tmp',
]);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface AllowEntry {
  readonly token: string;
  readonly reason: string;
  readonly until: string;
}

/** `token<TAB>reason<TAB>until`, one per line; `#` starts a comment line. */
export function parseAllowlist(
  text: string,
  where = ALLOWLIST_FILE,
): { readonly entries: readonly AllowEntry[]; readonly findings: Finding[] } {
  const entries: AllowEntry[] = [];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, at) => {
    if (line.trim() === '' || line.startsWith('#')) return;
    const here = `${where}:${at + 1}`;
    const bad = (message: string): number => findings.push({ check: 'vocabulary', where: here, message });
    const [token = '', reason = '', until = '', ...rest] = line.split('\t');
    if (rest.length > 0 || until === '') return void bad('is not token<TAB>reason<TAB>until');
    if (/\s/.test(token) || token === '') return void bad(`token "${token}" must be one whitespace-free token`);
    if (reason.trim() === '') return void bad(`token "${token}" has no reason`);
    if (!ALLOWLIST_UNTIL.includes(until.trim()))
      return void bad(`token "${token}": until is "${until}", not one of ${ALLOWLIST_UNTIL.join(' | ')}`);
    if (seen.has(token.toLowerCase())) return void bad(`token "${token}" is listed twice`);
    seen.add(token.toLowerCase());
    entries.push({ token, reason: reason.trim(), until: until.trim() });
  });
  return { entries, findings };
}

/** Counts the words in a text. Reviewed phrases and allowlisted tokens are blanked first; token uses are tallied. */
export class Counter {
  private readonly pattern: RegExp;
  private readonly tokens: readonly string[];
  readonly tokenUses = new Map<string, number>();

  constructor(words: Iterable<string>, allow: readonly AllowEntry[] = []) {
    const alternatives = [...words].map(word => `${escapeRegExp(word)}s?`).join('|');
    this.pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, 'giu');
    this.tokens = allow.map(entry => entry.token).sort((a, b) => b.length - a.length);
  }

  hits(text: string): number {
    if (text === '') return 0;
    let read = withoutExceptions(text);
    for (const token of this.tokens) {
      const pattern = new RegExp(escapeRegExp(token), 'giu');
      const found = read.match(pattern);
      if (found === null) continue;
      this.tokenUses.set(token, (this.tokenUses.get(token) ?? 0) + found.length);
      read = read.replace(pattern, ' ');
    }
    return read.match(this.pattern)?.length ?? 0;
  }
}

export interface Occurrence {
  readonly file: string;
  readonly line: number;
  readonly hits: number;
}

/** The hits of one TS or TSX file: sentences, JSX text and owner texts by position. */
export function scanSource(
  file: string,
  where: string,
  counter: Counter,
  oldSpellings: ReadonlyMap<string, string> = OLD_SPELLINGS,
): Occurrence[] {
  const out: Occurrence[] = [];
  let parsed: ReturnType<typeof parseFile>;
  try {
    parsed = parseFile(file);
  } catch {
    return out; // a file that does not parse is another check's finding
  }
  const add = (start: number, text: string): void => {
    const hits = counter.hits(text);
    if (hits > 0) out.push({ file: where, line: parsed.line(start), hits });
  };
  const identifierName = (node: unknown): string | undefined => {
    const n = node as { type?: string; name?: unknown } | null;
    return n !== null && typeof n === 'object' && typeof n.name === 'string' ? n.name : undefined;
  };
  const isOldSpelling = (parents: readonly AstNode[]): boolean =>
    oldSpellings.size > 0 &&
    parents.some(
      p =>
        p.type === 'VariableDeclarator' &&
        oldSpellings.has(`${where}#${identifierName((p as { id?: unknown }).id) ?? ''}`),
    );
  const inClassHelper = (parents: readonly AstNode[]): boolean =>
    parents.some(
      p => p.type === 'CallExpression' && CLASS_HELPERS.has(identifierName((p as { callee?: unknown }).callee) ?? ''),
    );

  walk(parsed.program, (node, parents) => {
    const parent = parents[parents.length - 1];
    if (parent === undefined) return;
    if (node.type === 'JSXText') {
      const value = node.value as string;
      if (value.trim() !== '') add(node.start, value);
      return;
    }
    const isString = node.type === 'Literal' && typeof node.value === 'string';
    if (!isString && node.type !== 'TemplateLiteral') return;
    if (
      [
        'ImportDeclaration',
        'ExportNamedDeclaration',
        'ExportAllDeclaration',
        'ImportExpression',
        'TSLiteralType',
        'TSImportType',
        'TSExternalModuleReference',
        'TSEnumMember',
      ].includes(parent.type)
    )
      return;
    if (['Property', 'MethodDefinition', 'PropertyDefinition', 'TSPropertySignature'].includes(parent.type)) {
      if ((parent as { key?: unknown }).key === node) return; // a key is an identifier, step 2's
    }
    if (isOldSpelling(parents) || inClassHelper(parents)) return;

    let text: string;
    if (node.type === 'TemplateLiteral') {
      if (parent.type === 'TaggedTemplateExpression') {
        const tag = (parent as unknown as { tag: AstNode }).tag;
        if (/^(css|keyframes|createGlobalStyle|styled)\b/.test(parsed.source.slice(tag.start, tag.end))) return;
      }
      const quasis = (node.quasis as { value: { raw: string } }[]).map(q => q.value.raw);
      text = quasis.join('${}');
    } else text = node.value as string;

    let owner = false;
    if (parent.type === 'JSXAttribute') {
      const attr = identifierName((parent as { name?: unknown }).name) ?? '';
      if (OWNER_ATTRS.has(attr)) owner = true;
      else if (NOT_TEXT_ATTRS.has(attr) || attr.startsWith('data-') || attr.startsWith('aria-')) return;
    } else if (parent.type === 'Property') {
      const key = identifierName((parent as { key?: unknown }).key);
      owner = key !== undefined && (parent as { computed?: boolean }).computed !== true && OWNER_KEYS.has(key);
    } else if (parent.type === 'CallExpression') {
      const callee = (parent as { callee?: AstNode }).callee;
      owner =
        callee?.type === 'MemberExpression' &&
        identifierName((callee as { property?: unknown }).property) === 'describe';
    }
    if (!owner && !/\s/.test(text)) return;
    if (node.type === 'TemplateLiteral') {
      // Every quasi is read through the whole template's text, so a placeholder never splits a word.
      add(node.start, (node.quasis as { value: { raw: string } }[]).map(q => q.value.raw).join(' '));
    } else add(node.start, text);
  });
  return out;
}

/** The hits of one Markdown file, by line. */
export function scanMarkdown(file: string, where: string, counter: Counter): Occurrence[] {
  const out: Occurrence[] = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, at) => {
      const hits = counter.hits(line);
      if (hits > 0) out.push({ file: where, line: at + 1, hits });
    });
  return out;
}

/** The folder that owns a root-relative file: its workspace package, else its first folder, else the root. */
export function scopeOf(rel: string, packageRels: readonly string[]): string {
  for (const pkg of packageRels) if (rel === pkg || rel.startsWith(`${pkg}/`)) return pkg;
  const slash = rel.indexOf('/');
  return slash === -1 ? '.' : rel.slice(0, slash);
}

export const pendingPathOf = (scope: string): string =>
  scope === '.' ? `${PENDING_NAME}/` : `${scope}/${PENDING_NAME}/`;

function isHistory(rel: string): boolean {
  for (const prefix of HISTORY_FOLDERS.keys()) {
    if (prefix === 'Changelog' ? /^Changelog[^/]*\.md$/.test(rel) : rel === prefix || rel.startsWith(prefix))
      return true;
  }
  return false;
}

const posix = (path: string): string => (sep === '/' ? path : path.split(sep).join('/'));
const productSegments = (rel: string): boolean => !rel.split('/').some(segment => SKIPPED_SEGMENTS.has(segment));
const isProductFile = (rel: string): boolean =>
  productSegments(rel) && !/\.(test|spec)\.[cm]?tsx?$/.test(rel) && !rel.endsWith('.d.ts');

function globFiles(root: string, cwd: string, pattern: string): string[] {
  if (!existsSync(join(root, cwd))) return [];
  const found: string[] = [];
  for (const match of new Bun.Glob(pattern).scanSync({ cwd: join(root, cwd), onlyFiles: true, dot: true }))
    found.push(posix(cwd === '.' ? match : join(cwd, match)));
  return found.filter(rel => !rel.split('/').includes('node_modules')).sort();
}

/** One hit as the ledger sees it: the file name it is kept under, where it sits and the line it sits on. */
export interface Site {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface ScopeCount {
  readonly count: number;
  readonly occurrences: readonly Occurrence[];
  /** One site per hit, in file and line order. */
  readonly sites: readonly Site[];
}

export interface Scan {
  readonly scopes: ReadonlyMap<string, ScopeCount>;
  readonly tokenUses: ReadonlyMap<string, number>;
  /** Every scope that could hold a pending file. */
  readonly validScopes: ReadonlySet<string>;
}

const slugOf = (file: string): string =>
  (file.split('/').pop() ?? file)
    .replace(/\.[^.]*$/u, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40) || 'file';

/** The hash a hit is kept under: its line, lower-cased, the old and new word masked, spaces collapsed. Not its path. */
export function lineHash(line: string, words: readonly string[]): string {
  const mask = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})s?(?![\\p{L}\\p{N}_])`,
    'giu',
  );
  const text = line.toLowerCase().replace(mask, 'W').replace(/\s+/gu, ' ').trim();
  return new Bun.CryptoHasher('sha1').update(text).digest('hex').slice(0, 8);
}

/** The ledger names of the hits `occurrences` hold, one per hit; identical lines get `__2`, `__3`. */
export function sitesOf(root: string, occurrences: readonly Occurrence[], words: readonly string[]): Site[] {
  const lines = new Map<string, string[]>();
  const seen = new Map<string, number>();
  const out: Site[] = [];
  for (const o of occurrences) {
    if (!lines.has(o.file)) lines.set(o.file, readFileSync(join(root, o.file), 'utf8').split('\n'));
    const text = (lines.get(o.file)?.[o.line - 1] ?? '').trim();
    for (let n = 0; n < o.hits; n++) {
      const stem = `${slugOf(o.file)}-${lineHash(text, words)}`;
      const count = (seen.get(stem) ?? 0) + 1;
      seen.set(stem, count);
      out.push({
        name: count === 1 ? stem : `${stem}__${count}`,
        file: o.file,
        line: o.line,
        text: text.slice(0, 200),
      });
    }
  }
  return out;
}

/** Reads every scanned file under `root`. `only` restricts the scan to one scope. */
export function scanTree(root: string, words: Iterable<string>, allow: readonly AllowEntry[], only?: string): Scan {
  const ws: Workspace = loadWorkspace(root);
  const packageRels = ws.packages.map(p => p.rel).sort((a, b) => b.length - a.length);
  const counter = new Counter(words, allow);
  const found = new Map<string, Occurrence[]>();
  const record = (scope: string, occurrences: readonly Occurrence[]): void => {
    if (occurrences.length === 0) return;
    found.set(scope, [...(found.get(scope) ?? []), ...occurrences]);
  };
  const wanted = (rel: string): string | undefined => {
    const scope = scopeOf(rel, packageRels);
    return only === undefined || scope === only ? scope : undefined;
  };

  const ts = new Set<string>();
  for (const pkg of ws.packages) {
    if (only !== undefined && pkg.rel !== only) continue;
    for (const file of sourceFiles(pkg, { tests: false })) {
      if (areaOf(pkg, file) === 'generated') continue;
      const rel = posix(relative(root, file));
      if (isProductFile(rel)) ts.add(rel);
    }
  }
  for (const top of ['scripts', 'migration'])
    for (const rel of globFiles(root, top, '**/*.{ts,tsx,mts}')) if (isProductFile(rel)) ts.add(rel);
  for (const rel of [...ts].sort()) {
    const scope = wanted(rel);
    if (scope !== undefined) record(scope, scanSource(join(root, rel), rel, counter));
  }

  const md = new Set<string>();
  for (const rel of globFiles(root, 'docs', '**/*.md')) md.add(rel);
  for (const rel of ['README.md', 'INSTALLATION.md', 'CLAUDE.md']) if (existsSync(join(root, rel))) md.add(rel);
  for (const rel of globFiles(root, 'packages', '**/README.md')) md.add(rel);
  for (const rel of globFiles(root, 'packages', '**/instructions/**/*.md')) md.add(rel);
  for (const rel of globFiles(root, 'migration', '**/README.md')) md.add(rel);
  for (const rel of globFiles(root, '.claude/skills', '**/*.md')) md.add(rel);
  for (const rel of [...md].sort()) {
    if (isHistory(rel) || rel.split('/').some(s => s === 'tests' || s === 'fixtures')) continue;
    const scope = wanted(rel);
    if (scope !== undefined) record(scope, scanMarkdown(join(root, rel), rel, counter));
  }

  const scopes = new Map<string, ScopeCount>();
  for (const [scope, occurrences] of [...found].sort(([a], [b]) => a.localeCompare(b)))
    scopes.set(scope, {
      count: occurrences.reduce((n, o) => n + o.hits, 0),
      occurrences,
      sites: sitesOf(root, occurrences, [...RATCHETED_WORDS.keys(), ...RATCHETED_WORDS.values()]),
    });
  const validScopes = new Set<string>([...packageRels, 'docs', 'scripts', 'migration', '.claude', '.']);
  return { scopes, tokenUses: counter.tokenUses, validScopes };
}

/** One scope's ledger folder: its path and the file names (without `.txt`) it holds. */
export interface PendingFile {
  readonly where: string;
  readonly names: readonly string[];
}

const LEDGER_NAME = /^[a-z0-9][a-z0-9-]*-[0-9a-f]{8}(?:__\d+)?$/u;
/** The hash and the stem of a ledger name, `undefined` when it is no ledger name. */
const stemOf = (name: string): string | undefined =>
  LEDGER_NAME.test(name) ? name.replace(/__\d+$/u, '').replace(/^.*-/u, '') : undefined;

/** Every `vocabulary-pending/` folder of a tree, by scope; a stray file or the retired count file becomes a finding. */
export function readPendingFiles(root: string): {
  readonly byScope: Map<string, PendingFile>;
  readonly findings: Finding[];
} {
  const byScope = new Map<string, PendingFile>();
  const findings: Finding[] = [];
  const names = new Map<string, string[]>();
  const walkDir = (rel: string, inside: boolean): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if ((NOT_SEARCHED as readonly string[]).includes(entry.name)) continue;
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if ((NOT_SEARCHED_PATHS as readonly string[]).includes(next)) continue;
      if (entry.isDirectory()) {
        if (inside) findings.push({ check: 'vocabulary', where: next, message: 'a ledger folder holds files only' });
        else walkDir(next, entry.name === PENDING_NAME);
      } else if (inside) {
        const name = entry.name.replace(/\.txt$/u, '');
        const scope = dirname(rel) === '.' ? '.' : dirname(rel);
        if (!entry.name.endsWith('.txt') || stemOf(name) === undefined)
          findings.push({
            check: 'vocabulary',
            where: next,
            message: 'is no ledger file: it is <name>-<8 hex digits>[__n].txt, one per remaining hit',
          });
        else names.set(scope, [...(names.get(scope) ?? []), name]);
      } else if (entry.name === LEGACY_NAME)
        findings.push({
          check: 'vocabulary',
          where: next,
          message: 'is the retired count file: one file per remaining hit under vocabulary-pending/ now',
        });
    }
  };
  walkDir('', false);
  for (const [scope, list] of [...names].sort(([a], [b]) => a.localeCompare(b)))
    byScope.set(scope, { where: pendingPathOf(scope), names: list.sort() });
  return { byScope, findings };
}

/** One scope of the base: the file names it held, or (a base that predates the folders) only how many hits it allowed. */
export interface BaseScope {
  readonly count: number;
  readonly names?: ReadonlySet<string>;
}

/**
 * The base ref's pending files by scope: a git ref, or `file:<dir>` (a tree, for tests). `undefined` when the ref
 * cannot be read or holds no ledger at all (the ratchet was not there yet, so there is nothing to compare).
 */
export function readBaseCounts(root: string, ref: string): Map<string, BaseScope> | undefined {
  try {
    const found = new Map<string, BaseScope>();
    if (ref.startsWith('file:')) {
      const dir = ref.slice(5);
      if (!existsSync(dir)) return undefined;
      for (const [scope, file] of readPendingFiles(dir).byScope)
        found.set(scope, { count: file.names.length, names: new Set(file.names) });
    } else {
      const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd: root, encoding: 'utf8' });
      if (listed.status !== 0) return undefined;
      const names = new Map<string, Set<string>>();
      for (const where of listed.stdout.split('\n')) {
        const folder = new RegExp(`^(?:(.*)/)?${PENDING_NAME}/([^/]+)\\.txt$`, 'u').exec(where);
        if (folder !== null) {
          const scope = folder[1] ?? '.';
          names.set(scope, (names.get(scope) ?? new Set<string>()).add(folder[2] ?? ''));
        } else if (where === LEGACY_NAME || where.endsWith(`/${LEGACY_NAME}`)) {
          const shown = spawnSync('git', ['show', `${ref}:${where}`], { cwd: root, encoding: 'utf8' });
          if (shown.status !== 0) return undefined;
          const count = (JSON.parse(shown.stdout) as { count?: unknown }).count;
          if (typeof count === 'number') found.set(dirname(where) === '.' ? '.' : dirname(where), { count });
        }
      }
      for (const [scope, set] of names) found.set(scope, { count: set.size, names: set });
    }
    return found.size === 0 ? undefined : found;
  } catch {
    return undefined;
  }
}

const sayWord = (): string => [...RATCHETED_WORDS].map(([old, word]) => `"${old}" → "${word}"`).join(', ');

const locate = (occurrences: readonly Occurrence[], limit = 4): string => {
  const shown = occurrences.slice(0, limit).map(o => `${o.file}:${o.line}`);
  return occurrences.length > limit ? `${shown.join(', ')} and ${occurrences.length - limit} more` : shown.join(', ');
};

/** The pure rule: the hits of each scope against its ledger folder and the base. */
export function ratchetFindings(
  scopes: ReadonlyMap<string, ScopeCount>,
  pending: ReadonlyMap<string, PendingFile>,
  base: ReadonlyMap<string, BaseScope> | undefined,
  validScopes: ReadonlySet<string>,
  only?: string,
): Finding[] {
  const check = 'vocabulary';
  const findings: Finding[] = [];
  const all = new Set<string>([...scopes.keys(), ...pending.keys()]);
  for (const scope of [...all].sort()) {
    if (only !== undefined && scope !== only) continue;
    const file = pending.get(scope);
    const here = scopes.get(scope);
    const target = pendingPathOf(scope);
    if (file !== undefined && !validScopes.has(scope)) {
      findings.push({
        check,
        where: file.where,
        message:
          'is outside the rule: a pending folder sits in a workspace package, docs, scripts, migration, .claude or the root',
      });
      continue;
    }
    // Hits and files meet by hash: a hit without a file is growth, a file without a hit was fixed.
    const files = new Map<string, string[]>();
    for (const name of file?.names ?? [])
      files.set(stemOf(name) ?? name, [...(files.get(stemOf(name) ?? name) ?? []), name]);
    const hits = new Map<string, Site[]>();
    for (const site of here?.sites ?? [])
      hits.set(stemOf(site.name) ?? site.name, [...(hits.get(stemOf(site.name) ?? site.name) ?? []), site]);
    const grown: Site[] = [];
    const gone: string[] = [];
    for (const key of new Set([...files.keys(), ...hits.keys()])) {
      const have = files.get(key) ?? [];
      const seen = hits.get(key) ?? [];
      if (seen.length > have.length) grown.push(...seen.slice(have.length));
      if (have.length > seen.length) gone.push(...have.slice(seen.length));
    }
    if (grown.length > 0)
      findings.push({
        check,
        where: scope,
        message: `${grown.length} hit${grown.length === 1 ? '' : 's'} of ${sayWord()} with no file in ${target}; new text uses the new word: ${locate(
          grown.map(site => ({ file: site.file, line: site.line, hits: 1 })),
        )}`,
      });
    for (const name of gone)
      findings.push({
        check,
        where: `${target}${name}.txt`,
        message: 'holds a hit that is gone: git rm this file',
      });
    if (base !== undefined && file !== undefined) {
      const before = base.get(scope);
      // A scope the base has no folder for, in a base that has folders at all, held nothing there.
      const beforeNames =
        before?.names ?? ([...base.values()].some(b => b.names !== undefined) ? new Set<string>() : undefined);
      if (beforeNames !== undefined) {
        for (const name of file.names)
          if (!beforeNames.has(name))
            findings.push({
              check,
              where: `${target}${name}.txt`,
              message: 'is not in the base: the ledger may only lose files',
            });
      } else if (file.names.length > (before?.count ?? 0))
        findings.push({
          check,
          where: file.where,
          message: `holds ${file.names.length} files but the base held ${before?.count ?? 0}: the ledger may only shrink`,
        });
    }
  }
  return findings;
}

export interface Report {
  readonly findings: Finding[];
  readonly table: string[];
}

export async function vocabularyReport(root: string, packageId?: string, base?: string): Promise<Report> {
  const ws = loadWorkspace(root);
  const only = packageId === undefined ? undefined : ws.byId(packageId)?.rel;
  const findings: Finding[] = [];
  const allowText = existsSync(join(root, ALLOWLIST_FILE)) ? readFileSync(join(root, ALLOWLIST_FILE), 'utf8') : '';
  const allow = parseAllowlist(allowText);
  findings.push(...allow.findings);
  const scan = scanTree(root, RATCHETED_WORDS.keys(), allow.entries, only);
  if (only === undefined)
    for (const entry of allow.entries)
      if ((scan.tokenUses.get(entry.token) ?? 0) === 0)
        findings.push({
          check: 'vocabulary',
          where: ALLOWLIST_FILE,
          message: `token "${entry.token}" is in no scanned text: remove it`,
        });
  const pending = readPendingFiles(root);
  findings.push(...pending.findings);
  const baseCounts = readBaseCounts(root, base ?? 'origin/rebuild/5.0-after');
  findings.push(...ratchetFindings(scan.scopes, pending.byScope, baseCounts, scan.validScopes, only));

  const table: string[] = [];
  let total = 0;
  for (const scope of [...new Set([...scan.scopes.keys(), ...pending.byScope.keys()])].sort()) {
    if (only !== undefined && scope !== only) continue;
    const count = scan.scopes.get(scope)?.count ?? 0;
    total += count;
    table.push(
      `${scope.padEnd(34)} ${String(count).padStart(5)}  (pending ${pending.byScope.get(scope)?.names.length ?? 0})`,
    );
  }
  table.push(
    `${'total'.padEnd(34)} ${String(total).padStart(5)}  (${sayWord()}; the base is ${baseCounts === undefined ? 'not compared' : 'compared'})`,
  );
  return { findings, table };
}

export const check: Check = {
  name: 'vocabulary',
  summary: 'owner- and agent-facing text uses the new word; the old word only goes down',
  async run(ctx) {
    const report = await vocabularyReport(ctx.root, ctx.packageId, ctx.base);
    for (const line of report.table) console.log(`vocabulary ${line}`);
    return report.findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
