/**
 * r12 H11 — NOTHING PARSES WITH DURIAN ON THE PAGE'S MAIN THREAD. A parse can take far longer than a frame and nothing on that
 * thread can stop it, so the one place the product reads a message is the Durian worker (`app/hypermedia/durian-worker.ts`),
 * which the page can terminate. This test holds the import graph to that: every module that imports Durian's parser (its
 * `parse`, `check`, `llmView`: the package's root entry), and every module that imports one of those, is named here, and a
 * new one fails until it is either moved into the worker or added here with its reason.
 *
 * It reads every non-test module with Bun's own transpiler, not with patterns over text: `scanImports` names every literal static and
 * dynamic import and ignores comments, strings and type-only imports, and the transpiled text (comments gone) is searched for
 * every `import(` whose argument is NOT a string literal. A computed import is how a module reaches code the scan cannot name,
 * so it is read too: a template whose literal start names a folder must not be able to land on a module that reaches the parser,
 * and one with no literal start at all FAILS (a specifier built at run time is not something this guard can prove anything about).
 * A relative specifier written `.js` is the `.ts` source it names. `durian-worker-bundle.test.ts` holds the other half: in the
 * BUILT bundles, Durian's parser lands only in the worker chunk.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../../../../../..');
const HYPERMEDIA = 'packages/plugins/conversation/app/hypermedia';

/** Every source module of the product: not a test, not a declaration, not installed code, not generated. */
const sources = [...new Bun.Glob('packages/**/*.{ts,tsx}').scanSync({ cwd: root })].filter(
  path =>
    !/(^|\/)(node_modules|tests|generated|dist)\//u.test(path) &&
    !path.endsWith('.d.ts') &&
    !/\.(test|spec)\.tsx?$/u.test(path),
);

interface Import {
  readonly specifier: string;
  readonly names: string;
  readonly kind: 'static' | 'dynamic';
}

/** A dynamic `import()` whose argument is not a string literal: its literal start (a template's), or `undefined` when it has none. */
interface Computed {
  readonly prefix: string | undefined;
}

const STATIC_NAMES = /^\s*(?:import|export)\s+([^;]*?)\s+from\s*['"]([^'"]+)['"]/gmu;

/**
 * The module's code with its comments blanked and the inside of its '…' and "…" strings blanked, and its template literals kept
 * (their literal start is what a computed import names). The transpiler cannot be asked for this: it folds a template with a
 * constant in it (`./${'x'}.ts`) into a plain string, which is exactly the shape to be read here. A tokenizer, not a regex, so a
 * quote inside a comment and a comment inside a string are each what they are.
 */
function withoutCommentsAndStrings(text: string): string {
  let out = '';
  let quote: string | undefined;
  for (let at = 0; at < text.length; at++) {
    const here = text[at] ?? '';
    const next = text[at + 1] ?? '';
    if (quote === undefined && here === '/' && next === '/') {
      while (at < text.length && text[at] !== '\n') at++;
      out += '\n';
    } else if (quote === undefined && here === '/' && next === '*') {
      const end = text.indexOf('*/', at + 2);
      at = end === -1 ? text.length : end + 1;
      out += ' ';
    } else if (quote === undefined && (here === "'" || here === '"')) {
      out += here;
      for (at++; at < text.length && text[at] !== here && text[at] !== '\n'; at++) if (text[at] === '\\') at++;
      out += here;
    } else {
      out += here;
      if (here === '`') quote = quote === undefined ? '`' : undefined;
    }
  }
  return out;
}

/** What a module imports at run time, and every dynamic import it computes. Type-only imports are erased by the transpiler. */
function readModule(path: string): { readonly imports: readonly Import[]; readonly computed: readonly Computed[] } {
  // A script's `#!` line is not TypeScript.
  const text = readFileSync(resolve(root, path), 'utf8').replace(/^#![^\n]*/u, '');
  const transpiler = new Bun.Transpiler({ loader: path.endsWith('x') ? 'tsx' : 'ts' });
  const imports: Import[] = transpiler.scanImports(text).map(each => ({
    specifier: each.path,
    names: '',
    kind: each.kind === 'dynamic-import' ? 'dynamic' : 'static',
  }));
  // The transpiled text has no comments and no type-only imports: the names an import takes are read from it.
  const js = transpiler.transformSync(text);
  const named = new Map<string, string>();
  for (const match of js.matchAll(STATIC_NAMES)) named.set(match[2] ?? '', match[1] ?? '');
  const computed: Computed[] = [];
  // Not a method that is NAMED `import` (`async import(request) {`, `.import(x)`): those are a definition and a call of one.
  for (const match of withoutCommentsAndStrings(text).matchAll(
    /(?<![.\w])(?<!async\s)import\(\s*(?!["'])([^)]*)\)(?!\s*\{)/gu,
  )) {
    const argument = (match[1] ?? '').trim();
    // A method signature (`import(request: Request): Promise<void>;`) names a typed parameter; no import expression is written `name: Type`.
    if (/^\w+\??\s*:\s*\S/u.test(argument)) continue;
    const literal = /^`([^`$]*)/u.exec(argument);
    computed.push({ prefix: literal === null || literal[1] === '' ? undefined : literal[1] });
  }
  return {
    imports: imports.map(each => ({ ...each, names: named.get(each.specifier) ?? '' })),
    computed,
  };
}

const modules = new Map(sources.map(path => [path, readModule(path)] as const));
const graph = new Map<string, readonly Import[]>([...modules].map(([path, each]) => [path, each.imports]));

const known = new Set(sources);

/** The module a relative specifier names, among the sources (a bundler query is not an import). */
function resolveRelative(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.') || specifier.includes('?')) return undefined;
  const target = relative(root, resolve(dirname(resolve(root, from)), specifier));
  // A specifier written `.js` (or `.jsx`) is the TypeScript source beside it.
  const bare = target.replace(/\.(?:js|jsx|mjs)$/u, '');
  return [target, bare, `${bare}.ts`, `${bare}.tsx`, `${bare}/index.ts`, `${bare}/index.tsx`].find(path =>
    known.has(path),
  );
}

/** Who imports each module, directly. */
const importers = new Map<string, string[]>();
for (const [from, imports] of graph)
  for (const each of imports) {
    const to = resolveRelative(from, each.specifier);
    if (to !== undefined) importers.set(to, [...(importers.get(to) ?? []), from]);
  }

/** Every module that imports `target`, directly. */
const importersOf = (target: string): string[] => [...new Set(importers.get(target) ?? [])];

/** Every module that reaches any of `starts` through imports, and the starts themselves. */
function reaching(starts: readonly string[]): Set<string> {
  const seen = new Set(starts);
  const pending = [...starts];
  for (let next = pending.pop(); next !== undefined; next = pending.pop())
    for (const importer of importersOf(next))
      if (!seen.has(importer)) {
        seen.add(importer);
        pending.push(importer);
      }
  return seen;
}

/** Durian's own root entry (`parse`, `check`, `llmView`, `setYamlParser`) and its server entry; the React entries are not parsers. */
const isParserEntry = (specifier: string): boolean =>
  specifier === 'durian-markdown' || specifier === 'durian-markdown/server';

describe('the Durian parser and the main thread', () => {
  it('is imported by three modules only: the message reader, its one-line YAML lock, and the CLI check', () => {
    const importers = [...graph]
      .filter(([, imports]) => imports.some(each => isParserEntry(each.specifier)))
      .map(([path]) => path)
      .sort();
    expect(importers).toEqual([
      `${HYPERMEDIA}/durian.ts`,
      `${HYPERMEDIA}/parse-message.ts`,
      // THE CLI EXEMPTION: `fy render check` runs in the `fy` binary on a host, in Bun, never in a page; it has no main thread to freeze.
      'packages/plugins/conversation/cli/reading/check.ts',
    ]);
  });

  it('is reached from the page only through the worker: the module graph above the reader is the worker and its answer function', () => {
    const above = reaching([`${HYPERMEDIA}/parse-message.ts`, `${HYPERMEDIA}/durian.ts`]);
    above.delete(`${HYPERMEDIA}/parse-message.ts`);
    above.delete(`${HYPERMEDIA}/durian.ts`);
    expect([...above].sort()).toEqual([`${HYPERMEDIA}/durian-answer.ts`, `${HYPERMEDIA}/durian-worker.ts`]);
  });

  it('is not started by any module: the worker is a bundler entry, never an import', () => {
    expect(importersOf(`${HYPERMEDIA}/durian-worker.ts`)).toEqual([]);
    expect(importersOf(`${HYPERMEDIA}/durian-answer.ts`)).toEqual([`${HYPERMEDIA}/durian-worker.ts`]);
  });

  it('is never reached by a dynamic import either: a literal one, a template one, or one with a computed specifier', () => {
    const parserModules = [
      `${HYPERMEDIA}/parse-message.ts`,
      `${HYPERMEDIA}/durian.ts`,
      `${HYPERMEDIA}/durian-answer.ts`,
      `${HYPERMEDIA}/durian-worker.ts`,
    ];
    for (const [path, imports] of graph)
      for (const each of imports.filter(each => each.kind === 'dynamic'))
        expect(
          parserModules.includes(resolveRelative(path, each.specifier) ?? ''),
          `${path} imports ${each.specifier} lazily`,
        ).toBe(false);
  });

  it('computes no dynamic import it cannot be read through: a template must start with a folder, and may land on no parser module', () => {
    const reachable = reaching([`${HYPERMEDIA}/parse-message.ts`, `${HYPERMEDIA}/durian.ts`]);
    for (const [path, { computed }] of modules)
      for (const each of computed) {
        expect(
          each.prefix,
          `${path} has a dynamic import with no literal start: it cannot be proved not to reach the parser`,
        ).toBeDefined();
        // What the pattern can name (a bundler's `*` does not cross a folder): a module whose path starts with the literal start,
        // with no further folder after it.
        const prefix = each.prefix ?? '';
        const start = resolve(root, dirname(path), prefix) + (prefix.endsWith('/') ? '/' : '');
        const landing = sources.filter(source => {
          const stem = resolve(root, source).replace(/\.tsx?$/u, '');
          return stem.startsWith(start) && !stem.slice(start.length).includes('/');
        });
        expect(landing.length, `${path} imports ${each.prefix}…: no module is there`).toBeGreaterThan(0);
        expect(
          landing.filter(source => reachable.has(source)),
          `${path} imports ${each.prefix}…, which can be a module that reaches the parser`,
        ).toEqual([]);
      }
  });

  it("is not called through the renderer's entries: no module takes parse, check or llmView from `durian-markdown/react`", () => {
    for (const [path, imports] of graph)
      for (const each of imports.filter(each => each.specifier.startsWith('durian-markdown/react')))
        expect(
          /\b(parse|check|llmView)\b/u.test(each.names),
          `${path} imports ${each.names} from ${each.specifier}`,
        ).toBe(false);
  });

  it('is asked for by the page through one hook, which one component uses: every surface that draws a message (the chat, the agenda and its cards) goes through it', () => {
    expect(importersOf(`${HYPERMEDIA}/use-durian-reading.ts`)).toEqual([`${HYPERMEDIA}/hypermedia-prose.tsx`]);
    // The surfaces that draw a message reach that component: the transcript row directly, every other one through `shell.prose`.
    const prose = reaching([`${HYPERMEDIA}/hypermedia-prose.tsx`]);
    expect(prose.has('packages/plugins/conversation/app/chat/transcript-row.tsx')).toBe(true);
    expect(prose.has(`${HYPERMEDIA}/demoting-prose.tsx`)).toBe(true);
  });
});
