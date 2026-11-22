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
beforeAll(async () => {
  worker = await measureBundle({ root: conversation, entry, plugins: [durianBuild.plugin] });
}, 240_000);

const has = (fragment: RegExp): string[] => worker.firstModules.filter(path => fragment.test(path));

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

  test('holds neither the chart evaluator nor the scene compiler (a chart and an animation are held as code in a message)', () => {
    expect(has(/durian-hypermedia\/src\/core\/(?:expr|chart|chart-llm|scene)\.ts$/u)).toEqual([]);
  });
});
