/**
 * r12 H11 — WHAT THE DURIAN WORKER CARRIES. It is built by the app shell's own Vite with the shell's Durian plugin (the build
 * the page's worker gets), and its module list is read from the build, not from the source: the worker is the parser and the
 * pure halves of our reading, and NOTHING of the page. No React, no shell barrel (`@ferretry/app`, whose import would start the
 * shell's whole graph inside a worker), no part drawn, and a single file: a worker that fetched a second chunk could not be
 * started from the one script the page's Trusted Types policy accepts.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { durianBuild } from '../../../app/vite-durian.ts';
import { type BundleSize, measureBundle } from '../../perf/support/bundle-size.ts';

const conversation = resolve(import.meta.dir, '../../..');
const entry = resolve(conversation, 'app/hypermedia/durian-worker.ts');

let worker: BundleSize;
let page: BundleSize;
beforeAll(async () => {
  worker = await measureBundle({ root: conversation, entry, plugins: [durianBuild.plugin, durianBuild.workerPlugin] });
  // The page: Conversation's whole app half (its entry, and every lazy chunk it reaches), built with the worker as the shell builds it.
  page = await measureBundle({
    root: conversation,
    entry: resolve(conversation, 'app/index.ts'),
    plugins: [durianBuild.plugin],
    workerPlugins: [durianBuild.plugin, durianBuild.workerPlugin],
  });
}, 480_000);

const has = (fragment: RegExp): string[] => worker.firstModules.filter(path => fragment.test(path));

const pageModules = (): string[] => [...page.firstModules, ...page.lazy.flatMap(chunk => chunk.modules)];

/**
 * THE BUILT HALF OF THE GUARD (`tests/unit/app/hypermedia/durian-main-thread.test.ts` reads the source; this reads what ships). However
 * a module came to import Durian's parser, if it is in a page chunk it is on the main thread: so Durian's parser (its document
 * reader and its core library) and the modules that run it are in the worker chunk, and in no chunk of the page.
 */
describe('the Durian parser in the built bundles', () => {
  test('is in the worker chunk', () => {
    expect(has(/durian-hypermedia\/src\/document\.ts$/u).length).toBe(1);
    expect(has(/durian-hypermedia\/src\/core\/dh-lib\.ts$/u).length).toBe(1);
    expect(has(/hypermedia\/parse-message\.ts$/u).length).toBe(1);
  });

  test("is in no chunk of the page, first-load or lazy: the page holds only the worker's url", () => {
    const modules = pageModules();
    // The page is the whole conversation app half: a real number of modules, so an empty scan cannot pass.
    expect(modules.length).toBeGreaterThan(500);
    expect(modules.filter(path => /durian-hypermedia\/src\/(?:document|core\/dh-lib)\.ts$/u.test(path))).toEqual([]);
    expect(
      modules.filter(path => /hypermedia\/(?:parse-message|durian|durian-answer|durian-worker)\.ts$/u.test(path)),
    ).toEqual([]);
  });

  test('is started by the page by its url alone: the worker module is a bundler entry the page never imports', () => {
    expect(pageModules().filter(path => path.includes('durian-worker.ts?worker&url')).length).toBe(1);
  });
});

describe('the Durian worker chunk', () => {
  test('is one file: nothing it needs is fetched later', () => {
    expect(worker.lazy.map(chunk => chunk.name)).toEqual([]);
  });

  test("holds Durian's parser and our parse halves", () => {
    expect(has(/durian-hypermedia\/src\/document\.ts$/u).length).toBe(1);
    expect(has(/durian-hypermedia\/src\/core\/dh-lib\.ts$/u).length).toBe(1);
    expect(has(/hypermedia\/fy-render-parse\.ts$/u).length).toBe(1);
    expect(has(/hypermedia\/fence-boundaries\.ts$/u).length).toBe(1);
  });

  test('holds no React, and no module that draws anything', () => {
    expect(has(/\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?react(?:-dom)?\//u)).toEqual([]);
    expect(has(/\.tsx$/u)).toEqual([]);
    expect(has(/durian-hypermedia\/src\/(?:react|ui)\//u)).toEqual([]);
  });

  test('holds none of the shell: its barrel and everything it starts are not in the worker', () => {
    expect(has(/packages\/app\/src\/index\.ts$/u)).toEqual([]);
    // What the worker takes from the shell is the `fy-render` numbers and palette and the reference grammar, by their own subpaths.
    const shell = has(/packages\/app\/src\//u).map(path => path.replace(/^.*packages\/app\/src\//u, ''));
    expect(shell.length).toBeGreaterThan(0);
    for (const path of shell)
      expect(path.startsWith('fy-render/') || path === 'references/grammar.ts', path).toBe(true);
  });

  test('needs no `document`: the entity decoder is its table build, not the DOM one (a worker has no document)', () => {
    expect(has(/decode-named-character-reference\/index\.dom\.js$/u)).toEqual([]);
    expect(has(/decode-named-character-reference\/index\.js$/u).length).toBe(1);
  });

  test('holds neither the chart evaluator nor the scene compiler (a chart and an animation are held as code in a message)', () => {
    expect(has(/durian-hypermedia\/src\/core\/(?:expr|chart|chart-llm|scene)\.ts$/u)).toEqual([]);
  });
});
