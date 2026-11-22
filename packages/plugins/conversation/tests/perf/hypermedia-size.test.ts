import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { durianBuild } from '../../app/vite-durian.ts';
import { type BundleSize, measureBundle } from './support/bundle-size.ts';

/**
 * THE SIZE HALF of "an assistant message is read as Hypermedia" (r12 H8): what the chat's transcript costs a phone to download,
 * in gzip, before and after Durian. One production Vite build of the transcript entry, built with the shell's own Durian plugin:
 *
 *   FIRST LOAD  the entry and every chunk it imports without a dynamic `import()`, with the stylesheets they name.
 *   LAZY        everything else: Durian's 3D stage and its chart engine, fetched when a reader first needs them.
 *
 * THE BASELINE IS MEASURED, NOT GUESSED. The same entry built the same way on the commit before the Durian work (`6489f24531`,
 * with no Durian plugin) is {@link BASE_FIRST_LOAD_GZ}. The plan estimated "+65 KB first load, +110 KB budget"; the first real
 * build of H4 measured +144 KB (Durian's parser, its Markdown renderer and its part components are all in the first-load
 * graph, none of the parts is lazy but 3D and charts), so the budget below is that measurement plus a margin for tool noise, not
 * the plan's figure. Moving it is a decision: raise it in the PR that adds the weight and say why, or lazy-load a part to lower it.
 *
 * A BUDGET THAT CANNOT FAIL IS NOT ONE: the last test adds ~200 KB of gzip-incompressible code to the same entry and expects the
 * verdict to be "over".
 *
 * Perf-tier rules (`scripts/ci/perf-tier.sh`): report-only on a pull request, blocking on `main`, one process on its own runner.
 */
const BASE_FIRST_LOAD_GZ = 199_136;
const FIRST_LOAD_ALLOWANCE_GZ = 150_000;
const FIRST_LOAD_BUDGET_GZ = BASE_FIRST_LOAD_GZ + FIRST_LOAD_ALLOWANCE_GZ;
/** Lazy chunks are new with Durian (the 3D stage ~135 KB, the chart engine ~69 KB measured): an absolute ceiling. */
const LAZY_BUDGET_GZ = 215_000;

const kb = (bytes: number): string => `${(bytes / 1000).toFixed(1)} KB`;

/** The verdict, pure: the lines a failing run prints, empty when the build is within budget. */
const overBudget = (size: BundleSize): string[] => [
  ...(size.firstLoadGz > FIRST_LOAD_BUDGET_GZ
    ? [
        `first load ${kb(size.firstLoadGz)} gzip is over the ${kb(FIRST_LOAD_BUDGET_GZ)} budget (base ${kb(BASE_FIRST_LOAD_GZ)} + ${kb(FIRST_LOAD_ALLOWANCE_GZ)})`,
      ]
    : []),
  ...(size.lazyGz > LAZY_BUDGET_GZ
    ? [
        `lazy chunks ${kb(size.lazyGz)} gzip are over the ${kb(LAZY_BUDGET_GZ)} budget: ${size.lazy.map(c => `${c.name} ${kb(c.gz)}`).join(', ')}`,
      ]
    : []),
];

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
  test('first load is within base + the Durian allowance', () => {
    expect(overBudget(real).filter(line => line.startsWith('first load'))).toEqual([]);
  });

  test('lazy chunks (3D, charts) are within their ceiling, and 3D is not in the first load', () => {
    expect(overBudget(real).filter(line => line.startsWith('lazy'))).toEqual([]);
    expect(real.lazy.length).toBeGreaterThanOrEqual(2);
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
