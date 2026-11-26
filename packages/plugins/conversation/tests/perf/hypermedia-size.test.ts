import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const MEASURED_FIRST_LOAD_GZ = 302_443;
/**
 * U1 of the DurianMarkdown swap (0.7.0) moved the first load from 296,152 to 302,443 B (+6.3 KB): the code walk part and its stylesheet, the
 * reference chip, the inline parts' views (maths, citations, glossary, spark) and the heading/table chrome of the new renderer. The
 * page's Markdown renderer takes `inlineText` from `durian-shims/inline-text.ts`, not from the module that holds the whole parser
 * (+400 KB gzip measured without it), and each part is imported from its own entry (`react/strict` holds all of them: +550 KB first
 * load and 950 KB of lazy chunks: pdf.js, three, cytoscape, lottie, chart.js). The lazy chunks of 0.6.2 (the 2D and 3D animation
 * engines, 171,439 B) are in no chunk now: nothing imports them while an animation is held as code.
 */
const MEASURED_LAZY_GZ = 83;
/** The parser worker's own chunk (the page fetches it before its first message is read), measured at U1: Durian's parser, KaTeX for `$…$`, every part's parser. */
const MEASURED_WORKER_GZ = 333_496;
const HEADROOM_GZ = 5_000;
const FIRST_LOAD_BUDGET_GZ = MEASURED_FIRST_LOAD_GZ + HEADROOM_GZ;
/** Lazy chunks: an absolute ceiling (the animation engines come back with the unit that draws animations, and raise it). */
const LAZY_BUDGET_GZ = MEASURED_LAZY_GZ + HEADROOM_GZ;
const WORKER_BUDGET_GZ = MEASURED_WORKER_GZ + HEADROOM_GZ;

const kb = (bytes: number): string => `${(bytes / 1000).toFixed(1)} KB`;

/** The verdict, pure: the lines a failing run prints, empty when the build is within budget. */
const overBudget = (size: BundleSize): string[] => [
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
  });
}, 240_000);

describe('the transcript bundle', () => {
  test('first load is within the measured budget, and under the plan’s +110 KB over the base', () => {
    expect(overBudget(real).filter(line => line.startsWith('first load'))).toEqual([]);
    expect(real.firstLoadGz - BASE_FIRST_LOAD_GZ).toBeLessThanOrEqual(PLAN_ALLOWANCE_GZ);
  });

  test('lazy chunks are within their ceiling', () => {
    expect(overBudget(real).filter(line => line.startsWith('lazy'))).toEqual([]);
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

  test('the parser worker is within its measured budget', () => {
    expect(worker.firstLoadGz).toBeLessThanOrEqual(WORKER_BUDGET_GZ);
    expect(worker.lazyGz).toBe(0);
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
    const verdict = overBudget(fat);
    expect(verdict.length).toBe(1);
    expect(verdict[0]).toContain('first load');
  }, 240_000);
});
