import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FOLDER_PART_NAMES } from 'durian-markdown';
import { durianBuild } from '../../app/vite-durian.ts';
import { type BundleSize, measureBundle } from './support/bundle-size.ts';

/**
 * THE SIZE HALF of "an assistant message is read as Hypermedia" (r12 H8): what the chat's transcript costs a phone to download,
 * in gzip, before and after Durian. One production Vite build of the transcript entry (with the stylesheet the Conversation
 * surfaces load beside it), built with the shell's own Durian plugin:
 *
 *   FIRST LOAD  the entry and every chunk it imports without a dynamic `import()`, with the stylesheets they name.
 *   LAZY        everything else: the 2D animation engine and Durian's 3D stage, fetched when a message first needs them.
 *
 * THE BASELINE IS MEASURED, NOT GUESSED. The same entry built the same way on the commit before the Durian work (`6489f24531`,
 * with no Durian plugin) is {@link BASE_FIRST_LOAD_GZ}. The plan estimated "+65 KB first load, +110 KB budget". The first real
 * build of H4 measured +144 KB; the review's breakdown (r12 H8) found what a first load did not need, and it is no longer in it:
 *   - Durian's chart evaluator and renderer (~9 KB): H4 holds every chart fence as code, so nothing evaluates one;
 *   - the 2D animation's scene compiler and stage (~36 KB): fetched for a message that has an animation;
 *   - the YAML reader (~29 KB): no part we draw reads YAML (`app/hypermedia/durian.ts`).
 * and the stylesheet Durian ships, which the first measurement MISSED (a package marked side-effect-free dropped its bare
 * import), is counted: +13 KB. The budget is the measured first load plus {@link HEADROOM_GZ} for tool noise, so a PR that
 * adds weight must say so here: raise it and say why, or lazy-load it.
 *
 * THE COLD CHAT PATH IS THE PAGE AND THE PARSER WORKER TOGETHER (U1 review, item 2). The page starts the worker when the first rich message
 * of a chat is read (`durian-spawn.ts`), so what a phone downloads before it can draw one is the first load PLUS the worker's own. A
 * budget for each alone hid +226,773 B: at the U1 pin the page was 299,228 -> 302,443 B and the worker 109,938 -> 333,496 B, together
 * 409,166 -> 635,939 B gzip (+55%). The worker is now its entry plus what it imports statically, and the folder parts' parsers and KaTeX
 * are chunks of their own, fetched when a message first needs one (`durian-shims/lazy-part.ts`): {@link COLD_BUDGET_GZ} is the sum, and
 * {@link PARENT_COLD_GZ} (the merge parent, measured with this same helper) is what the sum may not run away from.
 *
 * A BUDGET THAT CANNOT FAIL IS NOT ONE: the last test adds ~200 KB of gzip-incompressible code to the same entry and expects the
 * verdict to be "over". The module-graph tests below are the claim that survives a budget that has room: what must NOT be in a
 * first load is named, and what must be lazy is a chunk of its own.
 *
 * Perf-tier rules (`scripts/ci/perf-tier.sh`): report-only on a pull request, blocking on `main`, one process on its own runner.
 */
const BASE_FIRST_LOAD_GZ = 199_136;
/** The plan's allowance over the base, kept to say how the measurement stands against it. */
const PLAN_ALLOWANCE_GZ = 110_000;
/**
 * The first load as measured at this change, and the room above it for tool noise. r12 H13 (Durian 0.6.2) re-measured it: the same
 * entry on the commit before was 260,499 B (the parser has been in the worker since H11, so the page holds only its renderer), and
 * 0.6.2 added 35.7 KB, ALL of it the Markdown engine the renderer's `markdown.ts` creates at load: markdown-it and the five
 * libraries it imports replace `marked`. The compiler that a first measurement of 0.6.2 showed in it too (+81 KB, through the alignment
 * grid's chip widths) is kept out by `durian-shims/text-width.ts`.
 */
const MEASURED_FIRST_LOAD_GZ = 302_546;
/**
 * U1 of the DurianMarkdown swap (0.7.0) moved the first load from 296,152 to 302,443 B (+6.3 KB): the code walk part and its stylesheet, the
 * reference chip, the inline parts' views (maths, citations, glossary, spark) and the heading/table chrome of the new renderer. The
 * page's Markdown renderer takes `inlineText` from `durian-shims/inline-text.ts`, not from the module that holds the whole parser
 * (+400 KB gzip measured without it), and each part is imported from its own entry (`react/strict` holds all of them: +550 KB first
 * load and 950 KB of lazy chunks: pdf.js, three, cytoscape, lottie, chart.js). The lazy chunks of 0.6.2 (the 2D and 3D animation
 * engines, 171,439 B) are in no chunk now: nothing imports them while an animation is held as code.
 */
const MEASURED_LAZY_GZ = 83;
/**
 * The parser worker's first load (its entry and the chunk it imports statically: the page fetches both before its first message is read):
 * Durian's parser, its Markdown reader and the inline parts. At the U1 pin it was 333,496 B with every part's parser and KaTeX in it; with
 * those lazy it is {@link MEASURED_WORKER_GZ}, against 109,938 B for 0.6.2.
 */
const MEASURED_WORKER_GZ = 147_778;
/** What a message that uses EVERY lazy thing downloads on top of the worker's first load: the thirty-one parts' parsers and KaTeX (76,710 B of it). A ceiling, not a path anyone takes. */
const MEASURED_WORKER_LAZY_GZ = 209_422;
/** The page's first load and the worker's, on the merge parent (`origin/rebuild/5.0-after` at 0ef50946ed), measured with this same helper: 299,228 + 109,938. */
const PARENT_COLD_GZ = 409_166;
/**
 * What the cold path may exceed the parent by, and the reason there is any. The page is +3.3 KB (the code walk, the reference chip, the
 * inline parts' views). The worker is +37.8 KB and is all upstream's, in the code a chat message that uses no part still reads: the
 * vendored markdown-it (21 KB), the page-level parser (`core/dh-lib.ts`, `document.ts`, the diagram compilers it links), the inline parts
 * (citations, glossary, maths, spark) and the entity table. Durian's strict entry is not tree-shakable, so nothing Ferretry controls
 * takes them out; trimming them is for upstream (a parser entry that takes its parts as arguments).
 */
const MOST_OVER_PARENT_GZ = 45_000;
const HEADROOM_GZ = 5_000;
const FIRST_LOAD_BUDGET_GZ = MEASURED_FIRST_LOAD_GZ + HEADROOM_GZ;
/** Lazy chunks: an absolute ceiling (the animation engines come back with the unit that draws animations, and raise it). */
const LAZY_BUDGET_GZ = MEASURED_LAZY_GZ + HEADROOM_GZ;
const WORKER_BUDGET_GZ = MEASURED_WORKER_GZ + HEADROOM_GZ;
const WORKER_LAZY_BUDGET_GZ = MEASURED_WORKER_LAZY_GZ + HEADROOM_GZ;
/** The cold chat path: the page's first load plus the worker's. */
const COLD_BUDGET_GZ = MEASURED_FIRST_LOAD_GZ + MEASURED_WORKER_GZ + HEADROOM_GZ;

const kb = (bytes: number): string => `${(bytes / 1000).toFixed(1)} KB`;

/** The verdict, pure: the lines a failing run prints, empty when the build is within budget. `workerGz` is the parser worker's first load. */
const overBudget = (size: BundleSize, workerGz: number): string[] => [
  ...(size.firstLoadGz + workerGz > COLD_BUDGET_GZ
    ? [
        `cold path (page + parser worker) ${kb(size.firstLoadGz + workerGz)} gzip is over the ${kb(COLD_BUDGET_GZ)} budget (page ${kb(size.firstLoadGz)} + worker ${kb(workerGz)}; the merge parent was ${kb(PARENT_COLD_GZ)})`,
      ]
    : []),
  ...(size.firstLoadGz > FIRST_LOAD_BUDGET_GZ
    ? [
        `first load ${kb(size.firstLoadGz)} gzip is over the ${kb(FIRST_LOAD_BUDGET_GZ)} budget (measured ${kb(MEASURED_FIRST_LOAD_GZ)} + ${kb(HEADROOM_GZ)}; base ${kb(BASE_FIRST_LOAD_GZ)})`,
      ]
    : []),
  ...(size.lazyGz > LAZY_BUDGET_GZ
    ? [
        `lazy chunks ${kb(size.lazyGz)} gzip are over the ${kb(LAZY_BUDGET_GZ)} budget: ${size.lazy.map(c => `${c.name} ${kb(c.gz)}`).join(', ')}`,
      ]
    : []),
];

/** The Durian source modules by the path under `durian-markdown/src/` (a source path may be a symlinked or hashed install). */
const durianModule = (path: string): string | undefined => /durian-markdown\/(src\/.*)$/u.exec(path)?.[1];

const conversation = resolve(import.meta.dir, '../..');
const entry = resolve(import.meta.dir, 'fixtures/transcript-entry.tsx');
const plugins = [durianBuild.plugin];
const scratch = mkdtempSync(join(tmpdir(), 'fy-size-budget-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The page starts the Durian worker by its url (`?worker&url`): the shell builds that as a chunk of its own, with these plugins. */
const workerPlugins = [durianBuild.plugin, durianBuild.workerPlugin];
let real: BundleSize;
/** The parser worker's own build (the one the page's worker chunk is): where the parser and our stand-ins live since r12 H11. */
let worker: BundleSize;
beforeAll(async () => {
  real = await measureBundle({ root: conversation, entry, plugins, workerPlugins });
  worker = await measureBundle({
    root: conversation,
    entry: resolve(conversation, 'app/hypermedia/durian-worker.ts'),
    plugins: workerPlugins,
    modulePreload: false,
  });
}, 240_000);

describe('the transcript bundle', () => {
  test('first load is within the measured budget, and under the plan’s +110 KB over the base', () => {
    expect(overBudget(real, worker.firstLoadGz).filter(line => line.startsWith('first load'))).toEqual([]);
    expect(real.firstLoadGz - BASE_FIRST_LOAD_GZ).toBeLessThanOrEqual(PLAN_ALLOWANCE_GZ);
  });

  test('the COLD chat path, the page and the parser worker together, is within budget and within reach of the merge parent', () => {
    const cold = real.firstLoadGz + worker.firstLoadGz;
    expect(overBudget(real, worker.firstLoadGz).filter(line => line.startsWith('cold'))).toEqual([]);
    expect(cold - PARENT_COLD_GZ).toBeLessThanOrEqual(MOST_OVER_PARENT_GZ);
    // The review's number: the same two builds at the U1 pin were 635,939 B.
    expect(cold).toBeLessThan(635_939 - 150_000);
  });

  test('lazy chunks are within their ceiling', () => {
    expect(overBudget(real, worker.firstLoadGz).filter(line => line.startsWith('lazy'))).toEqual([]);
  });

  test('NO chart code is in the page or in the parser worker: every chart fence is held as code', () => {
    const everything = [
      ...real.firstModules,
      ...real.lazy.flatMap(chunk => chunk.modules),
      ...worker.firstModules,
      ...worker.lazy.flatMap(chunk => chunk.modules),
    ];
    const chart = everything.filter(path =>
      /\/(core\/(chart|chart-llm|expr)\.ts|ui\/(chart|chart-config)\.tsx?|react\/chart\.tsx)$|\/node_modules\/chart\.js\//u.test(
        path,
      ),
    );
    expect(chart).toEqual([]);
    // What stands in for the parser's chart reader is ours, and it is in the worker, which holds the parser (since r12 H11).
    expect(worker.firstModules.some(path => path.endsWith('hypermedia/durian-shims/chart-held.ts'))).toBe(true);
  });

  test('NO scene compiler and NO 3D stage is in the page or in the parser worker: the parser reaches the compiler through our door', () => {
    // Since H11 nothing imports the 2D engine (an animation is held as code until H14), so the compiler is in no chunk at all. The page's
    // alignment grid imported it for one function through Durian's chip widths until `text-width.ts` stood in (r12 H13: +81 KB gzip).
    const heavy =
      /^src\/(core\/(scene|scenes|story|camera|route|depth|data|still9|readable|edge10|stage(?!-budget)[\w-]*)|ui\/(anim|anim3d|cam3d|geo3d|stage))\./u;
    for (const size of [real, worker]) {
      const found = [...size.firstModules, ...size.lazy.flatMap(chunk => chunk.modules)]
        .map(durianModule)
        .filter((name): name is string => name !== undefined && heavy.test(name));
      expect(found).toEqual([]);
      expect(
        [...size.firstModules, ...size.lazy.flatMap(chunk => chunk.modules)].filter(path =>
          /\/node_modules\/three\//u.test(path),
        ),
      ).toEqual([]);
    }
    expect(worker.firstModules.some(path => path.endsWith('hypermedia/durian-shims/scene-late.ts'))).toBe(true);
    // The alignment grid is the page's, so the text-width stand-in is in the page's first load.
    expect(real.firstModules.some(path => path.endsWith('hypermedia/durian-shims/text-width.ts'))).toBe(true);
  });

  test('the parser worker is within its measured budget, and what is lazy in it stays within its own', () => {
    expect(worker.firstLoadGz).toBeLessThanOrEqual(WORKER_BUDGET_GZ);
    expect(worker.lazyGz).toBeLessThanOrEqual(WORKER_LAZY_BUDGET_GZ);
  });

  test('NO folder part’s parser and NO KaTeX is in the worker’s first load: each is a chunk of its own, fetched when a message first needs it', () => {
    const partModule = (path: string): string | undefined =>
      /durian-markdown\/src\/parts\/([\w-]+)\/(?:part|parse|compute)\.ts$/u.exec(path)?.[1];
    const first = worker.firstModules.map(partModule).filter((name): name is string => name !== undefined);
    expect(first).toEqual([]);
    const lazy = worker.lazy
      .flatMap(chunk => chunk.modules)
      .map(partModule)
      .filter((name): name is string => name !== undefined);
    // every part Durian registers is in a lazy chunk (the registry's own list: a part this test does not name fails it)
    expect(new Set(lazy).size).toBe(FOLDER_PART_NAMES.length);
    const katex = /\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?katex\//u;
    expect(worker.firstModules.filter(path => katex.test(path))).toEqual([]);
    const katexChunks = worker.lazy.filter(chunk => chunk.modules.some(path => katex.test(path)));
    expect(katexChunks.length).toBe(1);
    expect(worker.firstModules.some(path => path.endsWith('hypermedia/durian-shims/katex-late.ts'))).toBe(true);
    expect(worker.firstModules.some(path => path.endsWith('hypermedia/durian-shims/lazy-part.ts'))).toBe(true);
  });

  test('NO part’s view and none of their libraries is in the page: each part is imported from its own entry, never from react/strict', () => {
    const everything = [...real.firstModules, ...real.lazy.flatMap(chunk => chunk.modules)];
    // The folder parts' views (`src/parts/<name>/view.tsx`) and the libraries behind them. Only the inline parts' views (maths in a sentence, a citation, a glossary term, a spark) are the page's.
    const views = everything.filter(path =>
      /durian-markdown\/src\/parts\/(?!kit\/|inline|generated\/)[\w-]+\/(?:view|inline-view|segs|render)\.tsx?$/u.test(
        path,
      ),
    );
    expect(views.map(path => durianModule(path)).sort()).toEqual(
      [
        'src/parts/glossary/inline-view.tsx',
        'src/parts/glossary/segs.tsx',
        'src/parts/math/inline-view.tsx',
        'src/parts/math/view.tsx',
        'src/parts/references/inline-view.tsx',
        'src/parts/spark/inline-view.tsx',
      ].sort(),
    );
    expect(
      everything.filter(path =>
        /\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:pdfjs-dist|lottie-web|cytoscape|three|katex|chart\.js|chartjs-chart-matrix)\//u.test(
          path,
        ),
      ),
    ).toEqual([]);
  });

  test('the page holds none of the parser: not the Markdown reader, markdown-it, or a part’s parser (it reads `inlineText` from our one-function stand-in)', () => {
    const found = real.firstModules
      .map(durianModule)
      .filter(
        (name): name is string =>
          name !== undefined &&
          /^src\/(markdown\.ts|vendor\/|document\.ts|core\/dh-lib\.ts|parts\/[\w-]+\/(?:part|parse|compute)\.ts)/u.test(
            name,
          ),
      );
    expect(found).toEqual([]);
    expect(real.firstModules.some(path => path.endsWith('hypermedia/durian-shims/inline-text.ts'))).toBe(true);
  });

  test('no YAML reader is in the first load: no part a message draws reads YAML', () => {
    expect(real.firstModules.filter(path => /\/node_modules\/yaml\//u.test(path))).toEqual([]);
  });

  test('Durian’s stylesheet IS in the first load: the plugin keeps the bare import of a side-effect-free package', () => {
    // Durian's own selectors, not ours: the animation stage's mode button and the part chrome.
    const css = real.firstStyles.map(style => style.text).join('\n');
    expect(css).toContain('.dh-doc');
    expect(css).toContain('.scn-mode');
  });

  test('a fake +200 KB import fails the budget', async () => {
    // Random bytes do not compress, so ~200 KB of them is ~200 KB of gzip. Written beside nothing the repo owns.
    writeFileSync(
      join(scratch, 'ballast.js'),
      `export default ${JSON.stringify(randomBytes(200_000).toString('base64'))};`,
    );
    const fake = join(scratch, 'fake-entry.ts');
    writeFileSync(
      fake,
      `import ballast from './ballast.js';\nimport { Transcript } from ${JSON.stringify(entry)};\nObject.assign(globalThis, { ballast, Transcript });\n`,
    );
    const fat = await measureBundle({ root: conversation, entry: fake, plugins, workerPlugins });
    expect(fat.firstLoadGz - real.firstLoadGz).toBeGreaterThan(150_000);
    const verdict = overBudget(fat, worker.firstLoadGz);
    expect(verdict.length).toBe(2);
    expect(verdict.map(line => line.split(' ')[0]).sort()).toEqual(['cold', 'first']);
  }, 240_000);
});
