/**
 * SOURCE-TREE READERS for the changed-plugin scope (scripts/ci/scope.ts).
 *
 * The scope graph sees IMPORTS only, and a test that reads a source file by path (`readFileSync(join(import.meta.dir,
 * '../app/x.ts'))`, a `Bun.Glob` scan of every app, a copied directory) has an input no import names. A filter that
 * skips such a test silently stops the guard it carries. The policy, in one line: **a test that may read the source
 * tree always runs, unless it carries a CHECKED `scope-deps` declaration naming its real inputs.**
 *
 *   Detection (fails CLOSED, `readersOf`): a test file, and every test helper it imports transitively (relative
 *   imports into a tests / testing / support / fixtures / helpers folder, and a package's `testing` subpath), is a
 *   READER when it
 *     - anchors to its own location (`import.meta.dir|dirname|file|filename|path|url|resolve`, `__dirname`,
 *       `process.cwd()`, `Bun.main`; in a helper, only when the helper also reads), or
 *     - calls a file-system read API (readFile*, readdir*, opendir*, stat*, exists*, access*, cp*, copyFile*,
 *       createReadStream, glob*, `.scan`/`.scanSync`, `Bun.file`, ...) with a path that is not PROVABLY under a temp
 *       folder the test made itself, or
 *     - cannot be parsed or resolved.
 *   "Provably under a temp folder": every identifier of the path is derived (through `const`/assignment chains in the
 *   same file) from `mkdtemp*`, `tmpdir()` or the workspace `fixture()`, with no anchor on the way. A function
 *   parameter or a name with no initializer is neutral only next to such an identifier. Anything else is a doubt.
 *
 *   Declaration: `// scope-deps: <item>, <item>, ...` anywhere in the test file. An item is
 *     all            whole-repository scan: the test always runs (the same as no declaration, said on purpose)
 *     self           reads only its own package: no extra edge
 *     @ferretry/x    a workspace package: the test's package depends on it
 *     path | glob    a repo-relative file, folder or glob (`packages/plugins/onboarding/app`, `packages/plugins/*\/app`):
 *                    the test's package depends on every package that owns a match
 *   A declaration ADDS EDGES or keeps the test; it never only silences a warning. `checkDeclarations` fails (before
 *   any filtering, on every run) when an item names nothing that exists, is not a plain repo path, or the test file
 *   does not parse. The old `// scope-deps: manifests` marker above a computed `import()` is a different thing and is
 *   skipped here.
 *
 *   Declared GAPs: a spawned process or a production function that reads a path the test built from a plain string is
 *   not seen (the strings are not source-tree anchors); put such a test's inputs in a declaration when you write it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { importsAndOpaqueOf, parser } from '../gen/lib/imports.ts';
import type { Workspace } from '../gen/lib/workspace.ts';

type Node = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

/** Every child node of `node`, in any property. */
function* children(node: Node): Generator<Node> {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) for (const item of value) if (isNode(item)) yield item;
    if (isNode(value)) yield value;
  }
}
function* descend(node: Node): Generator<Node> {
  yield node;
  for (const child of children(node)) yield* descend(child);
}

// Names that read the file system wherever they appear (the `.scan()` of a Bun.Glob included).
const READ_APIS = new Set([
  'readFile',
  'readFileSync',
  'readdir',
  'readdirSync',
  'opendir',
  'opendirSync',
  'readlink',
  'readlinkSync',
  'statSync',
  'lstat',
  'lstatSync',
  'existsSync',
  'accessSync',
  'cp',
  'cpSync',
  'copyFile',
  'copyFileSync',
  'createReadStream',
  'globSync',
  'scan',
  'scanSync',
  'readTextFile',
  'openSync',
  'readv',
  'readvSync',
  'realpathSync',
]); // prettier-ignore
// Names that are also ordinary method names (`dialog.open()`): a read only on a file-system binding.
const FS_ONLY_APIS = new Set(['open', 'watch', 'file', 'exists', 'stat', 'access', 'glob', 'readText', 'realpath']);
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'bun']);
const FS_OBJECTS = new Set(['fs', 'fsp', 'fsPromises', 'promises', 'Bun']);
const SPAWN_APIS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork', '$']);
const SEEDS = new Set(['mkdtemp', 'mkdtempSync', 'tmpdir', 'fixture']);
const PURE = new Set([
  'join',
  'resolve',
  'dirname',
  'basename',
  'relative',
  'normalize',
  'extname',
  'path',
  'posix',
  'sep',
  'String',
  'JSON',
  'Buffer',
  'encodeURIComponent',
  'undefined',
  'Object',
  'Array',
  'Promise',
  'Math',
]); // prettier-ignore
const ANCHOR_META = new Set(['dir', 'dirname', 'file', 'filename', 'path', 'url', 'resolve']);

const calleeName = (callee: unknown): string | undefined => {
  if (!isNode(callee)) return undefined;
  if (callee.type === 'Identifier') return callee.name as string;
  if (callee.type === 'MemberExpression' && !callee.computed && isNode(callee.property))
    return callee.property.name as string;
  return undefined;
};

/** Identifier references of an expression (no property names, no object keys, no type annotations). */
function identifiersOf(expr: Node): string[] {
  const names: string[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'Identifier') names.push(node.name as string);
    else if (node.type === 'MemberExpression') {
      visit(node.object as Node);
      if (node.computed) visit(node.property as Node);
    } else if (node.type === 'Property') {
      if (node.computed) visit(node.key as Node);
      visit(node.value as Node);
    } else if (/^TS(As|NonNull|Satisfies|TypeAssertion)/.test(node.type)) {
      if (isNode(node.expression)) visit(node.expression);
    } else if (!node.type.startsWith('TS')) for (const child of children(node)) visit(child);
  };
  visit(expr);
  return names;
}

const hasSeedCall = (expr: Node): boolean =>
  [...descend(expr)].some(node => node.type === 'CallExpression' && SEEDS.has(calleeName(node.callee) ?? ''));

const isAnchor = (node: Node): string | undefined => {
  if (node.type === 'MemberExpression' && isNode(node.object) && node.object.type === 'MetaProperty') {
    const name = isNode(node.property) ? (node.property.name as string) : '';
    return ANCHOR_META.has(name) ? `import.meta.${name}` : undefined;
  }
  if (node.type === 'Identifier' && (node.name === '__dirname' || node.name === '__filename')) return node.name;
  if (node.type === 'CallExpression' && isNode(node.callee) && node.callee.type === 'MemberExpression') {
    const object = node.callee.object;
    const property = node.callee.property;
    if (isNode(object) && isNode(property) && object.name === 'process' && property.name === 'cwd')
      return 'process.cwd()';
  }
  if (
    node.type === 'MemberExpression' &&
    isNode(node.object) &&
    node.object.name === 'Bun' &&
    isNode(node.property) &&
    node.property.name === 'main'
  )
    return 'Bun.main';
  return undefined;
};

export interface FileReads {
  /** Why the file may read outside its own temp folders; empty when it provably does not. */
  readonly reasons: string[];
  /** Absolute helper files it imports. */
  readonly helpers: string[];
}

const lineOf = (source: string, offset: unknown): number => {
  let line = 1;
  const end = typeof offset === 'number' ? offset : 0;
  for (let i = 0; i < end && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
};

/** One file on its own: its anchors and its read calls, without its helpers. */
export function readsOf(file: string, source: string, isTest: boolean): string[] {
  let program: Node;
  try {
    const parsed = parser()(file, source, { sourceType: 'module' });
    if (parsed.errors.length > 0) return [`the file could not be parsed (${parsed.errors[0]?.message ?? 'error'})`];
    program = parsed.program as unknown as Node;
  } catch (error) {
    return [`the file could not be parsed (${error instanceof Error ? error.message : String(error)})`];
  }
  const nodes = [...descend(program)];
  // Local names bound to a file-system module (`import { stat } from 'node:fs/promises'`, `import * as fs`).
  const fsBound = new Set<string>();
  for (const node of nodes)
    if (node.type === 'ImportDeclaration' && isNode(node.source) && FS_MODULES.has(node.source.value as string))
      for (const spec of node.specifiers as Node[]) if (isNode(spec.local)) fsBound.add(spec.local.name as string);
  const isFsRead = (name: string, callee: unknown): boolean => {
    if (READ_APIS.has(name)) return true;
    if (!FS_ONLY_APIS.has(name) || !isNode(callee)) return false;
    if (callee.type === 'Identifier') return fsBound.has(name);
    const root = (function top(expr: unknown): string | undefined {
      if (!isNode(expr)) return undefined;
      if (expr.type === 'Identifier') return expr.name as string;
      return expr.type === 'MemberExpression' ? top(expr.object) : undefined;
    })(callee);
    return root !== undefined && (FS_OBJECTS.has(root) || fsBound.has(root));
  };

  // Names, and everything assigned to them.
  const inits = new Map<string, Node[]>();
  const neutral = new Set<string>();
  const bind = (pattern: unknown, init: Node | undefined): void => {
    if (!isNode(pattern)) return;
    if (pattern.type === 'Identifier') {
      const name = pattern.name as string;
      const literal = init !== undefined && init.type === 'Literal' && (init.value === '' || init.value === null);
      if (init === undefined || literal) neutral.add(name);
      else inits.set(name, [...(inits.get(name) ?? []), init]);
    } else if (pattern.type === 'AssignmentPattern') bind(pattern.left, undefined);
    else for (const child of children(pattern)) bind(child, init);
  };
  for (const node of nodes) {
    if (node.type === 'VariableDeclarator') bind(node.id, isNode(node.init) ? node.init : undefined);
    else if (node.type === 'AssignmentExpression' && isNode(node.right)) bind(node.left, node.right);
    else if (/^(Arrow)?Function/.test(node.type) && Array.isArray(node.params))
      for (const p of node.params) bind(p, undefined);
    else if (node.type === 'CatchClause') bind(node.param, undefined);
  }

  const safe = new Set<string>();
  const anchorless = (expr: Node): boolean => ![...descend(expr)].some(node => isAnchor(node) !== undefined);
  const qualifies = (expr: Node): boolean => {
    if (!anchorless(expr)) return false;
    if (hasSeedCall(expr)) return true;
    return identifiersOf(expr).some(name => safe.has(name));
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, list] of inits)
      if (!safe.has(name) && list.every(init => qualifies(init))) {
        safe.add(name);
        changed = true;
      }
  }
  const pathIsSafe = (expr: Node): boolean => {
    if (!anchorless(expr)) return false;
    const names = identifiersOf(expr);
    const seeded = hasSeedCall(expr) || names.some(name => safe.has(name));
    return seeded && names.every(name => safe.has(name) || neutral.has(name) || PURE.has(name) || SEEDS.has(name));
  };

  const reasons: string[] = [];
  const at = (node: Node): string => `line ${lineOf(source, node.start)}`;
  for (const node of nodes) {
    const anchor = isAnchor(node);
    if (anchor !== undefined && isTest) reasons.push(`${at(node)}: ${anchor} locates files relative to the test`);
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') continue;
    const name = calleeName(node.callee);
    if (name === undefined) continue;
    const args = (node.arguments as unknown[]).filter(isNode);
    if (isFsRead(name, node.callee)) {
      const checked = /^(cp|copyFile)/.test(name) ? args.slice(0, 2) : args.slice(0, 1);
      // `scan({ cwd })`: the options object is the path.
      const target = name.startsWith('scan') ? args : checked;
      if (target.length === 0 || !target.every(pathIsSafe))
        reasons.push(`${at(node)}: ${name}(...) reads a path not provably under a temp folder`);
    } else if (node.type === 'NewExpression' && name === 'Glob') {
      continue; // matching a string is pure; the scan is checked above
    } else if (SPAWN_APIS.has(name) && !args.some(pathIsSafe) && args.some(arg => !anchorless(arg)))
      reasons.push(`${at(node)}: ${name}(...) runs a process rooted at the test's location`);
  }
  return reasons;
}

const HELPER_DIR = /(^|\/)(tests?|testing|support|fixtures?|helpers?)\//;
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

const resolveFile = (from: string, specifier: string): string | undefined => {
  const base = resolve(dirname(from), specifier);
  return EXTENSIONS.map(extension => `${base}${extension}`).find(candidate => {
    try {
      return /\.[cm]?[jt]sx?$/.test(candidate) && existsSync(candidate) && readFileSync(candidate) !== undefined;
    } catch {
      return false;
    }
  });
};

function* filesUnder(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) yield path;
  }
}

/** The helper files one file imports: relative paths into a helper folder, and a package's `testing` subpath. */
function helpersOf(ws: Workspace, file: string, root: string): { files: string[]; reasons: string[] } {
  const files: string[] = [];
  const reasons: string[] = [];
  let edges: ReturnType<typeof importsAndOpaqueOf>['edges'];
  try {
    edges = importsAndOpaqueOf(ws, file).edges;
  } catch (error) {
    return {
      files,
      reasons: [`its imports could not be read (${error instanceof Error ? error.message : String(error)})`],
    };
  }
  for (const edge of edges) {
    if (edge.specifier.startsWith('.')) {
      const target = resolveFile(file, edge.specifier);
      if (target === undefined) {
        if (
          !/\.(jsonl?|css|md|txt|ya?ml|svg|png|wasm)$/.test(edge.specifier) &&
          HELPER_DIR.test(relative(root, resolve(dirname(file), edge.specifier)))
        )
          reasons.push(`line ${edge.line}: the helper ${edge.specifier} could not be resolved`);
        continue;
      }
      if (HELPER_DIR.test(relative(root, target))) files.push(target);
    } else if (edge.toPkg !== undefined && (edge.toArea === 'contract-testing' || edge.toArea === 'kernel-testing')) {
      const dir =
        edge.toArea === 'kernel-testing'
          ? join(edge.toPkg.dir, 'testing')
          : join(edge.toPkg.dir, 'contract', 'testing');
      files.push(...filesUnder(dir));
    }
  }
  return { files, reasons };
}

/** The reasons a test file (and its helpers, transitively) may read outside its own temp folders; empty when none. */
export function readersOf(ws: Workspace, testFile: string, cache = new Map<string, FileReads>()): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string, isTest: boolean): void => {
    if (seen.has(file)) return;
    seen.add(file);
    let entry = cache.get(file);
    if (entry === undefined) {
      const own = readsOf(file, readFileSync(file, 'utf8'), isTest);
      const found = helpersOf(ws, file, ws.root);
      entry = { reasons: [...own, ...found.reasons], helpers: found.files };
      cache.set(file, entry);
    }
    const where = relative(ws.root, file);
    // A helper's anchors alone are not a read; its reads (and a helper that cannot be understood) are.
    for (const reason of entry.reasons)
      if (isTest || !/ locates files relative to the test$/.test(reason)) reasons.push(`${where}: ${reason}`);
    for (const helper of entry.helpers) visit(helper, false);
  };
  visit(testFile, true);
  return reasons;
}

// ─── declarations ─────────────────────────────────────────────────────────────────────────────────────────────────

const DECLARATION = /^\s*\/\/\s*scope-deps:\s*(.*?)\s*$/;
const MANIFESTS_ONLY = /^manifests$/;

export interface Declaration {
  readonly items: readonly string[];
  readonly line: number;
}

/** The `// scope-deps:` lines of a test file, merged; undefined when it has none. */
export function declarationOf(source: string): Declaration | undefined {
  const items: string[] = [];
  let line = 0;
  source.split('\n').forEach((text, index) => {
    const match = DECLARATION.exec(text);
    if (match === null || MANIFESTS_ONLY.test(match[1] as string)) return;
    if (line === 0) line = index + 1;
    items.push(...(match[1] as string).split(',').map(item => item.trim()));
  });
  return line === 0 ? undefined : { items, line };
}

/** Every file of the repository (relative, `/`-separated), without dependencies, VCS data or build output. */
export function repoFiles(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', '.worktrees', '.tmp', 'coverage', 'dist']);
  const visit = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  visit('');
  return out;
}

export interface Resolved {
  /** `all`: the test always runs. */
  readonly all: boolean;
  /** Absolute paths (or package names) the declaration names; empty for `self`. */
  readonly packages: readonly string[];
  readonly problems: readonly string[];
}

/** Resolves a declaration against the repository. A name that matches nothing is a problem. */
export function resolveDeclaration(ws: Workspace, files: readonly string[], declaration: Declaration): Resolved {
  let all = false;
  const packages = new Set<string>();
  const problems: string[] = [];
  const names = new Map(ws.packages.map(pkg => [pkg.name, pkg] as const));
  for (const item of declaration.items) {
    if (item === 'all') all = true;
    else if (item === 'self') continue;
    else if (item.startsWith('@') || (!item.includes('/') && !item.includes('*') && names.has(item))) {
      if (names.has(item)) packages.add(item);
      else problems.push(`${JSON.stringify(item)} is no workspace package`);
    } else if (
      item === '' ||
      item.startsWith('/') ||
      item.includes('\\') ||
      item.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
    )
      problems.push(`${JSON.stringify(item)} is not a plain repository path`);
    else {
      const glob = item.includes('*') || item.includes('?') || item.includes('{') ? new Bun.Glob(item) : undefined;
      const matches = files.filter(file =>
        glob !== undefined ? glob.match(file) : file === item || file.startsWith(`${item.replace(/\/$/, '')}/`),
      );
      if (matches.length === 0) problems.push(`${JSON.stringify(item)} matches no file or folder`);
      for (const match of matches) {
        const owner = ws.ownerOf(join(ws.root, match));
        if (owner !== undefined) packages.add(owner.name);
      }
    }
  }
  return { all, packages: [...packages], problems };
}
