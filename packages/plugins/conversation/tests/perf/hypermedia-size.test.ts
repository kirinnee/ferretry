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
/** The first load as measured at this change (r12 H8 fix), and the room above it for tool noise. */
const MEASURED_FIRST_LOAD_GZ = 278_023;
const MEASURED_LAZY_GZ = 171_439;
const HEADROOM_GZ = 5_000;
const FIRST_LOAD_BUDGET_GZ = MEASURED_FIRST_LOAD_GZ + HEADROOM_GZ;
/** Lazy chunks: the 3D stage (~135 KB) and the 2D animation engine (~37 KB), an absolute ceiling. */
const LAZY_BUDGET_GZ = MEASURED_LAZY_GZ + HEADROOM_GZ;

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

/** The Durian source modules by the path under `durian-hypermedia/src/` (a source path may be a symlinked or hashed install). */
const durianModule = (path: string): string | undefined => /durian-hypermedia\/(src\/.*)$/u.exec(path)?.[1];
const firstDurian = (size: BundleSize): string[] =>
  size.firstModules.map(durianModule).filter((name): name is string => name !== undefined);

const conversation = resolve(import.meta.dir, '../..');
const entry = resolve(import.meta.dir, 'fixtures/transcript-entry.tsx');
const plugins = [durianBuild.plugin];
const scratch = mkdtempSync(join(tmpdir(), 'fy-size-budget-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let real: BundleSize;
beforeAll(async () => {
  real = await measureBundle({ root: conversation, entry, plugins });
}, 240_000);

describe('the transcript bundle', () => {
  test('first load is within the measured budget, and under the plan’s +110 KB over the base', () => {
    expect(overBudget(real).filter(line => line.startsWith('first load'))).toEqual([]);
    expect(real.firstLoadGz - BASE_FIRST_LOAD_GZ).toBeLessThanOrEqual(PLAN_ALLOWANCE_GZ);
  });

  test('lazy chunks are within their ceiling', () => {
    expect(overBudget(real).filter(line => line.startsWith('lazy'))).toEqual([]);
  });

  test('NO chart code is in the first load, or in the build at all: H4 holds every chart fence as code', () => {
    const everything = [...real.firstModules, ...real.lazy.flatMap(chunk => chunk.modules)];
    const chart = everything.filter(path =>
      /\/(core\/(chart|chart-llm|expr)\.ts|ui\/(chart|chart-config)\.tsx?|react\/chart\.tsx)$|\/node_modules\/chart\.js\//u.test(
        path,
      ),
    );
    expect(chart).toEqual([]);
    // What stands in for the parser's chart reader is ours, and it is in the first load.
    expect(real.firstModules.some(path => path.endsWith('hypermedia/durian-shims/chart-held.ts'))).toBe(true);
  });

  test('the 2D animation engine (scene compiler, stage) is one lazy chunk, and the 3D stage another', () => {
    const first = firstDurian(real);
    expect(
      first.filter(name => /^src\/(core\/(scene|story|camera|still9)|ui\/(anim|anim3d|cam3d|geo3d))\./u.test(name)),
    ).toEqual([]);
    const engine = real.lazy.find(chunk => chunk.modules.some(path => durianModule(path) === 'src/core/scene.ts'));
    expect(engine).toBeDefined();
    expect(engine?.modules.some(path => durianModule(path) === 'src/ui/anim.tsx')).toBe(true);
    const threeD = real.lazy.find(chunk => chunk.modules.some(path => durianModule(path) === 'src/ui/anim3d.ts'));
    expect(threeD).toBeDefined();
    expect(threeD?.name).not.toBe(engine?.name);
    // The parser reaches the compiler through our door, which the first load holds.
    expect(real.firstModules.some(path => path.endsWith('hypermedia/durian-shims/scene-late.ts'))).toBe(true);
  });

  test('no YAML reader is in the first load: no part a message draws reads YAML', () => {
    expect(real.firstModules.filter(path => /\/node_modules\/yaml\//u.test(path))).toEqual([]);
  });

  test('Durian’s stylesheet IS in the first load: the bare import survives the side-effect-free package', () => {
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
    const fat = await measureBundle({ root: conversation, entry: fake, plugins });
    expect(fat.firstLoadGz - real.firstLoadGz).toBeGreaterThan(150_000);
    const verdict = overBudget(fat);
    expect(verdict.length).toBe(1);
    expect(verdict[0]).toContain('first load');
  }, 240_000);
});
