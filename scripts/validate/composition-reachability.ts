/**
 * Composition-root reachability gate.
 *
 * Fails when a production module under `packages/<pkg>/src/**` is never *used* by that package's
 * composition root.
 *
 * Why this exists, and why the two knip gates do not already cover it: three adversarial reviews
 * independently found the same defect — a unit builds a module, tests it to 100%, and never mounts
 * it in the composition root, so the capability does not exist in the shipped product. Two separate
 * mechanisms launder that dead code past file-level dead-code analysis:
 *
 *   1. `knip.json` lists the test globs as entry points, so a module imported only by its own tests
 *      counts as reachable. This walk never enters `tests/` at all.
 *   2. A barrel (`export * from './x.ts'`) makes every module beneath it load at runtime, so
 *      file-level reachability — what `knip.production.json` measures — always says "used", even
 *      when nothing anywhere asks for a single one of its symbols. This walk is symbol-aware: a
 *      re-export edge is followed only for the names an importer actually demands.
 *
 * So reachability here means: starting at the composition root, some symbol of the module is
 * transitively demanded. Loading a module is not using it.
 *
 * Composition roots are the package's `bin` entries when it has any, otherwise its `exports`
 * entries (a library package with no binary has its public surface as its contract).
 *
 * The parser is lexical, not a regex over raw source: comments and string literals are removed
 * before any statement is matched, so an identifier inside a comment or a string is never mistaken
 * for an import. Two tripwires guard against parser drift — `assertNoMissedEdges` and the
 * unresolvable-name failure — and both exit 2 rather than silently under-reporting.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** Sentinel demand meaning "every exported name". A space keeps it out of the identifier space. */
const ALL = ' all';

const USAGE = 'usage: composition-reachability.ts <repo-root> <allowlist-file>';

// ─── lexing ───────────────────────────────────────────────────────────────────────────────────

/** Placeholder delimiters for extracted string literals; never valid TypeScript source characters. */
const STRING_OPEN = '\u0001';
const STRING_CLOSE = '\u0002';
const STRING_TOKEN = `${STRING_OPEN}(\\d+)${STRING_CLOSE}`;

/** A source with comments blanked and every string literal swapped for an indexed placeholder. */
interface CleanSource {
  readonly text: string;
  readonly literals: readonly string[];
}

/** True when a `/` in this position starts a regex literal rather than a division operator. */
function startsRegex(previousSignificant: string): boolean {
  if (previousSignificant === '') return true;
  return !/[)\]}\w$]/.test(previousSignificant);
}

function clean(source: string): CleanSource {
  const literals: string[] = [];
  let out = '';
  let index = 0;
  let previousSignificant = '';
  /** Brace depth each open template literal resumes at, innermost last. */
  const templateResumeDepths: number[] = [];
  let braceDepth = 0;

  const emit = (text: string): void => {
    out += text;
    const trimmed = text.trimEnd();
    if (trimmed.length > 0) previousSignificant = trimmed.slice(-1);
  };

  const emitLiteral = (value: string): void => {
    literals.push(value);
    out += `${STRING_OPEN}${literals.length - 1}${STRING_CLOSE}`;
    previousSignificant = 'x';
  };

  /** Consume template text from `index`; returns true when it stopped at a `${` interpolation. */
  const consumeTemplateChunk = (): boolean => {
    while (index < source.length) {
      const character = source[index];
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character === '`') {
        index += 1;
        return false;
      }
      if (character === '$' && source[index + 1] === '{') {
        index += 2;
        return true;
      }
      index += 1;
    }
    return false;
  };

  const openInterpolation = (): void => {
    templateResumeDepths.push(braceDepth);
    braceDepth += 1;
    emit('+(');
  };

  while (index < source.length) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      out += ' ';
      continue;
    }

    if (character === '/' && startsRegex(previousSignificant)) {
      index += 1;
      let inCharacterClass = false;
      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          index += 2;
          continue;
        }
        if (current === '\n') break;
        if (current === '[') inCharacterClass = true;
        else if (current === ']') inCharacterClass = false;
        else if (current === '/' && !inCharacterClass) break;
        index += 1;
      }
      index += 1;
      emit('0');
      continue;
    }

    if (character === "'" || character === '"') {
      index += 1;
      let value = '';
      while (index < source.length && source[index] !== character) {
        if (source[index] === '\\') {
          value += source[index + 1] ?? '';
          index += 2;
          continue;
        }
        value += source[index];
        index += 1;
      }
      index += 1;
      emitLiteral(value);
      continue;
    }

    if (character === '`') {
      index += 1;
      const interpolated = consumeTemplateChunk();
      emit('0');
      if (interpolated) openInterpolation();
      continue;
    }

    if (character === '{') {
      braceDepth += 1;
      emit('{');
      index += 1;
      continue;
    }

    if (character === '}') {
      const resumeDepth = templateResumeDepths.at(-1);
      if (resumeDepth !== undefined && braceDepth - 1 === resumeDepth) {
        templateResumeDepths.pop();
        braceDepth -= 1;
        index += 1;
        emit(')+0');
        if (consumeTemplateChunk()) openInterpolation();
        continue;
      }
      braceDepth -= 1;
      emit('}');
      index += 1;
      continue;
    }

    emit(character);
    index += 1;
  }

  return { text: out, literals };
}

// ─── module parsing ───────────────────────────────────────────────────────────────────────────

interface NamedReexport {
  readonly specifier: string;
  /** Exported name → the name it is taken under from the source module. */
  readonly names: ReadonlyMap<string, string>;
}

interface NamespaceReexport {
  readonly specifier: string;
  readonly alias: string;
}

interface PlainImport {
  readonly specifier: string;
  /** Demanded names, or `ALL` for namespace, side-effect, and dynamic imports. */
  readonly names: ReadonlySet<string>;
}

interface ModuleFacts {
  readonly localExports: ReadonlySet<string>;
  readonly imports: readonly PlainImport[];
  readonly namedReexports: readonly NamedReexport[];
  readonly starReexports: readonly string[];
  readonly namespaceReexports: readonly NamespaceReexport[];
  /** Every module specifier the file references, for the cross-check against Bun's own scanner. */
  readonly specifiers: ReadonlySet<string>;
}

/** Split an `{ a, b as c, type D }` clause into exported → source-name pairs. */
function parseBraceClause(clause: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const rawPart of clause.split(',')) {
    const part = rawPart.trim().replace(/^type\s+/, '');
    if (part.length === 0) continue;
    const aliased = /^([A-Za-z_$][\w$]*|default)\s+as\s+([A-Za-z_$][\w$]*|default)$/.exec(part);
    if (aliased) {
      pairs.set(aliased[2] ?? '', aliased[1] ?? '');
      continue;
    }
    const plain = /^([A-Za-z_$][\w$]*|default)$/.exec(part);
    if (plain) pairs.set(plain[1] ?? '', plain[1] ?? '');
  }
  return pairs;
}

/** The identifiers bound by a `const`/`let`/`var` declarator list, destructuring included. */
function declaredNames(declarators: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let segment = '';

  const flush = (): void => {
    const binding = (segment.split('=')[0] ?? '').trim();
    if (binding.length === 0) return;
    const identifiers = [...binding.matchAll(/[A-Za-z_$][\w$]*/g)].map(match => match[0]);
    // A destructuring pattern binds every identifier in it; anything else binds only its head,
    // so a type annotation such as `x: Record<string, number>` contributes nothing.
    if (binding.startsWith('{') || binding.startsWith('[')) names.push(...identifiers);
    else if (identifiers[0] !== undefined) names.push(identifiers[0]);
    segment = '';
  };

  for (const character of declarators) {
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) {
      flush();
      continue;
    }
    segment += character;
  }
  flush();
  return names;
}

/** Demanded names for an import clause such as `Default, { a as b }` or `* as ns`. */
function importedNames(clause: string): Set<string> {
  const names = new Set<string>();
  if (/\*\s*as\s+[A-Za-z_$][\w$]*/.test(clause)) {
    names.add(ALL);
    return names;
  }
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) for (const source of parseBraceClause(braces[1] ?? '').values()) names.add(source);
  const head = (braces ? clause.slice(0, braces.index) : clause)
    .replace(/^\s*type\s+/, '')
    .replace(/,\s*$/, '')
    .trim();
  if (/^[A-Za-z_$][\w$]*$/.test(head)) names.add('default');
  return names;
}

function parseModule(source: string): ModuleFacts {
  const { text, literals } = clean(source);
  const specifiers = new Set<string>();
  const literalAt = (index: string | undefined): string => {
    const value = literals[Number(index)] ?? '';
    specifiers.add(value);
    return value;
  };

  const localExports = new Set<string>();
  const imports: PlainImport[] = [];
  const namedReexports: NamedReexport[] = [];
  const starReexports: string[] = [];
  const namespaceReexports: NamespaceReexport[] = [];

  // `export * as ns from '...'`
  for (const match of text.matchAll(
    new RegExp(String.raw`\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*${STRING_TOKEN}`, 'g'),
  )) {
    namespaceReexports.push({ specifier: literalAt(match[2]), alias: match[1] ?? '' });
  }

  // `export * from '...'`
  for (const match of text.matchAll(new RegExp(String.raw`\bexport\s+\*\s+from\s*${STRING_TOKEN}`, 'g'))) {
    starReexports.push(literalAt(match[1]));
  }

  // `export { a, b as c } from '...'`
  for (const match of text.matchAll(
    new RegExp(String.raw`\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*${STRING_TOKEN}`, 'g'),
  )) {
    namedReexports.push({ specifier: literalAt(match[2]), names: parseBraceClause(match[1] ?? '') });
  }

  // `export { a, b as c }` — a local list; those bindings already exist in this module.
  for (const match of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from\b)/g)) {
    for (const exported of parseBraceClause(match[1] ?? '').keys()) localExports.add(exported);
  }

  if (/\bexport\s+default\b/.test(text)) localExports.add('default');

  // `export [declare] [async] function|class|interface|type|enum|namespace Name`
  for (const match of text.matchAll(
    /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    localExports.add(match[1] ?? '');
  }

  // `export const a = 1, b = 2`
  for (const match of text.matchAll(/\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([^;\n]*)/g)) {
    for (const name of declaredNames(match[1] ?? '')) localExports.add(name);
  }

  // `import Default, { a as b } from '...'` and `import * as ns from '...'`. The clause charset
  // stops the lazy match from stepping over a preceding statement.
  for (const match of text.matchAll(
    new RegExp(String.raw`\bimport\s+(?!type\s*\{)([A-Za-z0-9_$*,{}\s]*?)\s*from\s*${STRING_TOKEN}`, 'g'),
  )) {
    imports.push({ specifier: literalAt(match[2]), names: importedNames(match[1] ?? '') });
  }

  // `import type { A } from '...'` — a real edge even though it erases at runtime.
  for (const match of text.matchAll(
    new RegExp(String.raw`\bimport\s+type\s*\{([^}]*)\}\s*from\s*${STRING_TOKEN}`, 'g'),
  )) {
    imports.push({ specifier: literalAt(match[2]), names: new Set(parseBraceClause(match[1] ?? '').values()) });
  }

  // `import '...'` — a side-effect import runs the whole module graph beneath it.
  for (const match of text.matchAll(new RegExp(String.raw`\bimport\s*${STRING_TOKEN}`, 'g'))) {
    imports.push({ specifier: literalAt(match[1]), names: new Set([ALL]) });
  }

  // `import('...')` — dynamic; assume the whole module is wanted.
  for (const match of text.matchAll(new RegExp(String.raw`\bimport\s*\(\s*${STRING_TOKEN}`, 'g'))) {
    imports.push({ specifier: literalAt(match[1]), names: new Set([ALL]) });
  }

  return { localExports, imports, namedReexports, starReexports, namespaceReexports, specifiers };
}

// ─── module graph ─────────────────────────────────────────────────────────────────────────────

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(2);
}

/** Resolve a relative specifier to a repo-relative `.ts` path, or null when it is not our code. */
function resolveSpecifier(importer: string, specifier: string, root: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(root, dirname(importer), specifier);
  if (base.endsWith('.json')) return null;
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (!candidate.endsWith('.ts') && !candidate.endsWith('.tsx')) continue;
    if (existsSync(candidate)) return relative(root, candidate);
  }
  return fail(`cannot resolve '${specifier}' imported by ${importer}`);
}

/**
 * Cross-check the hand-written lexer against Bun's own transpiler: every module specifier Bun sees
 * must be one we also saw. Bun erases type-only imports, so the reverse does not hold. A mismatch
 * means the lexer drifted and the walk would silently under-report, so it is a hard error.
 */
function assertNoMissedEdges(file: string, source: string, facts: ModuleFacts): void {
  const loader = file.endsWith('.tsx') ? 'tsx' : 'ts';
  const scanned = new Bun.Transpiler({ loader }).scan(source);
  const missed = scanned.imports.map(entry => entry.path).filter(path => !facts.specifiers.has(path));
  if (missed.length > 0) {
    fail(`import parser missed ${missed.join(', ')} in ${file} — the reachability lexer needs fixing`);
  }
}

class ModuleGraph {
  private readonly facts = new Map<string, ModuleFacts>();
  private readonly exportNamesCache = new Map<string, ReadonlySet<string>>();

  constructor(private readonly root: string) {}

  factsFor(file: string): ModuleFacts {
    const cached = this.facts.get(file);
    if (cached) return cached;
    const source = readFileSync(resolve(this.root, file), 'utf8');
    const parsed = parseModule(source);
    assertNoMissedEdges(file, source, parsed);
    this.facts.set(file, parsed);
    return parsed;
  }

  /** Resolve an edge, treating `tests/` as off the graph: test code cannot make production live. */
  edge(importer: string, specifier: string): string | null {
    const target = resolveSpecifier(importer, specifier, this.root);
    if (target !== null && /(^|\/)tests\//.test(target)) return null;
    return target;
  }

  /** Every name a module exports, following star re-exports into our own modules. */
  exportNames(file: string, seen: ReadonlySet<string> = new Set()): ReadonlySet<string> {
    const cached = this.exportNamesCache.get(file);
    if (cached) return cached;
    if (seen.has(file)) return new Set();

    const facts = this.factsFor(file);
    const names = new Set<string>(facts.localExports);
    for (const reexport of facts.namedReexports) for (const name of reexport.names.keys()) names.add(name);
    for (const reexport of facts.namespaceReexports) names.add(reexport.alias);
    for (const specifier of facts.starReexports) {
      const target = this.edge(file, specifier);
      if (target === null) continue;
      for (const name of this.exportNames(target, new Set([...seen, file]))) names.add(name);
    }

    if (seen.size === 0) this.exportNamesCache.set(file, names);
    return names;
  }

  /** True when a star chain leaves our own code, so an unknown name is legitimately opaque. */
  hasExternalStar(file: string, seen: ReadonlySet<string> = new Set()): boolean {
    if (seen.has(file)) return false;
    for (const specifier of this.factsFor(file).starReexports) {
      const target = this.edge(file, specifier);
      if (target === null) return true;
      if (this.hasExternalStar(target, new Set([...seen, file]))) return true;
    }
    return false;
  }
}

/** Walk demand from the roots and return every module whose symbols are transitively wanted. */
function reachableFrom(graph: ModuleGraph, roots: readonly string[]): ReadonlySet<string> {
  const demanded = new Map<string, Set<string>>();
  const queue: string[] = [];

  const demand = (file: string, names: Iterable<string>): void => {
    const current = demanded.get(file);
    if (current === undefined) {
      demanded.set(file, new Set(names));
      queue.push(file);
      return;
    }
    const before = current.size;
    for (const name of names) current.add(name);
    if (current.size !== before) queue.push(file);
  };

  for (const root of roots) demand(root, [ALL]);

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined) continue;
    const facts = graph.factsFor(file);
    const wanted = demanded.get(file) ?? new Set<string>();
    const wantsAll = wanted.has(ALL);

    // The module body executes, so every direct import it makes is live.
    for (const entry of facts.imports) {
      const target = graph.edge(file, entry.specifier);
      if (target !== null) demand(target, entry.names);
    }

    for (const reexport of facts.namespaceReexports) {
      if (!wantsAll && !wanted.has(reexport.alias)) continue;
      const target = graph.edge(file, reexport.specifier);
      if (target !== null) demand(target, [ALL]);
    }

    for (const reexport of facts.namedReexports) {
      const forwarded = [...reexport.names.entries()]
        .filter(([exported]) => wantsAll || wanted.has(exported))
        .map(([, sourceName]) => sourceName);
      if (forwarded.length === 0) continue;
      const target = graph.edge(file, reexport.specifier);
      if (target !== null) demand(target, forwarded);
    }

    if (wantsAll) {
      for (const specifier of facts.starReexports) {
        const target = graph.edge(file, specifier);
        if (target !== null) demand(target, [ALL]);
      }
      continue;
    }

    // Named demand is the only thing that reaches through a star barrel, and only as far as the
    // module that actually declares the name. This is what stops a barrel laundering dead code.
    const provided = new Set<string>([
      ...facts.localExports,
      ...facts.namedReexports.flatMap(reexport => [...reexport.names.keys()]),
      ...facts.namespaceReexports.map(reexport => reexport.alias),
    ]);
    for (const name of wanted) {
      if (name === ALL || provided.has(name)) continue;
      let routed = false;
      for (const specifier of facts.starReexports) {
        const target = graph.edge(file, specifier);
        if (target === null) {
          routed = true;
          continue;
        }
        if (graph.exportNames(target).has(name)) {
          demand(target, [name]);
          routed = true;
        }
      }
      if (!routed && !graph.hasExternalStar(file)) {
        fail(`'${name}' is imported from ${file} but nothing there exports it — the export parser needs fixing`);
      }
    }
  }

  return new Set(demanded.keys());
}

// ─── package discovery ────────────────────────────────────────────────────────────────────────

interface Manifest {
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, string>;
}

/** Composition roots for a package: its `bin` entries, or its public `exports` when it has none. */
function compositionRoots(root: string, packageDir: string): string[] {
  const manifestPath = join(packageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')) as Manifest;
  const entries = Object.keys(manifest.bin ?? {}).length > 0 ? manifest.bin : manifest.exports;
  const roots = Object.values(entries ?? {})
    .filter(entry => typeof entry === 'string' && entry.endsWith('.ts'))
    .map(entry => join(packageDir, entry));
  if (roots.length === 0) fail(`${manifestPath} declares no bin or exports entry to use as a composition root`);
  for (const file of roots) {
    if (!existsSync(resolve(root, file))) fail(`${manifestPath} points at a missing composition root: ${file}`);
  }
  return roots;
}

function trackedFiles(root: string, pathspec: string): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard', '--', pathspec], { cwd: root });
  if (result.exitCode !== 0) fail(`git ls-files failed for ${pathspec}`);
  return result.stdout
    .toString()
    .split('\n')
    .filter(line => line.length > 0);
}

// ─── allowlist ────────────────────────────────────────────────────────────────────────────────

/**
 * Read the enumerated allowlist.
 *
 * Every entry is an exact repo-relative path with a reason on the same line. No globs, no
 * directories: silencing a module has to cost a reviewable line in the diff, and the file has to
 * shrink to zero as units wire their work.
 */
function readAllowlist(path: string, label: string): ReadonlySet<string> {
  if (!existsSync(path)) fail(`missing allowlist: ${label}`);
  const allowed = new Set<string>();

  for (const [offset, raw] of readFileSync(path, 'utf8').split('\n').entries()) {
    const line = raw.trim();
    const at = `${label}:${offset + 1}`;
    if (line.length === 0 || line.startsWith('#')) continue;

    const separator = line.indexOf('#');
    if (separator < 0) fail(`${at}: entry needs a trailing '# <reason>' naming the unit that must wire it`);
    const entry = line.slice(0, separator).trim();
    const reason = line.slice(separator + 1).trim();
    if (entry.length === 0) fail(`${at}: entry is empty`);
    if (reason.length === 0) fail(`${at}: entry needs a non-empty reason`);
    if (/[*?[\]]/.test(entry)) fail(`${at}: globs are forbidden — name the exact file (${entry})`);
    if (entry.endsWith('/')) fail(`${at}: directories are forbidden — name the exact file (${entry})`);
    if (!entry.endsWith('.ts')) fail(`${at}: only .ts modules can be allowlisted (${entry})`);
    if (allowed.has(entry)) fail(`${at}: duplicate entry (${entry})`);
    allowed.add(entry);
  }

  return allowed;
}

// ─── entry point ──────────────────────────────────────────────────────────────────────────────

const [rootArgument, allowlistArgument] = process.argv.slice(2);
if (rootArgument === undefined || allowlistArgument === undefined) fail(USAGE);
const repoRoot = resolve(rootArgument);
const graph = new ModuleGraph(repoRoot);

const packageDirectories = trackedFiles(repoRoot, 'packages/*/package.json')
  .map(file => dirname(file))
  .sort();
if (packageDirectories.length === 0) fail('no workspace packages found under packages/');

const unreachable: string[] = [];
for (const packageDirectory of packageDirectories) {
  const modules = trackedFiles(repoRoot, `${packageDirectory}/src`).filter(
    file => file.endsWith('.ts') && !file.endsWith('.d.ts'),
  );
  if (modules.length === 0) continue;
  // Parse every module, not only the ones the walk visits, so the lexer tripwires cover the whole
  // tree. Otherwise a parse bug hides in exactly the files this gate has already flagged, and
  // surfaces later as a confusing exit 2 in the PR that wires them.
  for (const file of modules) graph.factsFor(file);
  const reachable = reachableFrom(graph, compositionRoots(repoRoot, packageDirectory));
  unreachable.push(...modules.filter(file => !reachable.has(file)));
}
unreachable.sort();

const allowlist = readAllowlist(resolve(repoRoot, allowlistArgument), allowlistArgument);
const unreachableSet = new Set(unreachable);
const stale = [...allowlist].filter(entry => !unreachableSet.has(entry)).sort();
const violations = unreachable.filter(file => !allowlist.has(file));

let failed = false;

if (violations.length > 0) {
  failed = true;
  process.stderr.write('❌ production modules are never used by their package composition root:\n');
  for (const file of violations) process.stderr.write(`   ${file}\n`);
  process.stderr.write(
    `   Wire each one into the composition root, or add an exact path and reason to ${allowlistArgument}.\n`,
  );
}

if (stale.length > 0) {
  failed = true;
  process.stderr.write(`❌ stale allowlist entries in ${allowlistArgument} — these are wired now, delete them:\n`);
  for (const entry of stale) process.stderr.write(`   ${entry}\n`);
}

if (failed) process.exit(1);

process.stdout.write(
  `✅ Every production module is used by its composition root (allowlist: ${allowlist.size} entries)\n`,
);
