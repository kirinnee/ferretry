/**
 * r12 H11 — NOTHING PARSES WITH DURIAN ON THE PAGE'S MAIN THREAD. A parse can take far longer than a frame and nothing on that
 * thread can stop it, so the one place the product reads a message is the Durian worker (`app/hypermedia/durian-worker.ts`),
 * which the page can terminate. This test holds the import graph to that: every module that imports Durian's parser (its
 * `parse`, `check`, `llmView`: the package's root entry), and every module that imports one of those, is named here, and a
 * new one fails until it is either moved into the worker or added here with its reason.
 *
 * It reads the source text of every non-test module under `packages/` (static `import`/`export … from`, no type-only ones: a
 * type is erased, and `?worker&url` is a bundler query that makes a worker, not an import). Dynamic `import()` is read too,
 * since it is how a module reaches code lazily.
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

const STATIC = /^\s*(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+['"]([^'"]+)['"]/gmu;
const SIDE_EFFECT = /^\s*import\s+['"]([^'"]+)['"]/gmu;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu;

/** The imports of a module that are not type-only. */
function importsOf(text: string): readonly Import[] {
  const found: Import[] = [];
  for (const match of text.matchAll(STATIC))
    found.push({ specifier: match[2] ?? '', names: match[1] ?? '', kind: 'static' });
  for (const match of text.matchAll(SIDE_EFFECT)) found.push({ specifier: match[1] ?? '', names: '', kind: 'static' });
  for (const match of text.matchAll(DYNAMIC)) found.push({ specifier: match[1] ?? '', names: '', kind: 'dynamic' });
  return found;
}

const graph = new Map<string, readonly Import[]>(
  sources.map(path => [path, importsOf(readFileSync(resolve(root, path), 'utf8'))]),
);

const known = new Set(sources);

/** The module a relative specifier names, among the sources (a bundler query is not an import). */
function resolveRelative(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.') || specifier.includes('?')) return undefined;
  const target = relative(root, resolve(dirname(resolve(root, from)), specifier));
  return [target, `${target}.ts`, `${target}.tsx`].find(path => known.has(path));
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
  specifier === 'durian-hypermedia' || specifier === 'durian-hypermedia/server';

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

  it('is never reached by a dynamic import either', () => {
    const parserModules = ['parse-message', 'durian-answer', 'durian-worker', '/durian.ts'];
    for (const [path, imports] of graph)
      for (const each of imports.filter(each => each.kind === 'dynamic'))
        expect(
          parserModules.some(name => each.specifier.includes(name) && !each.specifier.includes('worker-url')),
          `${path} imports ${each.specifier} lazily`,
        ).toBe(false);
  });

  it("is not called through the renderer's entries: no module takes parse, check or llmView from `durian-hypermedia/react`", () => {
    for (const [path, imports] of graph)
      for (const each of imports.filter(each => each.specifier.startsWith('durian-hypermedia/react')))
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
