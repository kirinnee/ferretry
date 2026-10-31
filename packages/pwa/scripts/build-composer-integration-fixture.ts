/**
 * Builds the real-browser composer scene: the app's stylesheet (through Tailwind, as Vite builds it)
 * and `tests/integration/fixtures/composer-editor-scene.tsx`, written to `--out <dir>`.
 *
 * A CHILD PROCESS, never a `Bun.build` inside the test runner: a component-graph build in the runner
 * is what wedged the two-file integration run (see `build-fy-render-integration-fixture.ts`).
 *
 * Prints one JSON line naming the two files.
 *
 * `--entry <path>` (relative to the package) builds another scene against the same stylesheet — the
 * all-machines list's (`tests/integration/fixtures/all-machines-scene.tsx`) uses it.
 *
 * BUILT ONCE PER KEY. About twenty visual test files each asked for a build of their own, ~3.3 s
 * apiece, almost all of it the same Tailwind stylesheet. Each output is now kept under the temporary
 * directory, keyed by a hash of everything a build can read (`sceneInputPatterns` in
 * `tests/integration/support/fixture-inputs.ts`: sources, fixtures and the support files they import,
 * configs, manifests, the lockfile, `NODE_ENV` and the Bun version). The hash is recomputed on every ask
 * and never stored, so an edited input is a new key whether or not the run has a temporary directory of
 * its own (`scripts/test/swept.sh` gives CI one; a local harness run shares `/tmp`). The stylesheet is
 * shared by every scene; a scene's bundle by every file that asks for it. Writes land through a rename,
 * so two test processes asking at once never read half a file. `FY_FIXTURE_CACHE=off` builds every time.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '../tailwind.config.ts';
import {
  cachedText,
  cacheRootFor,
  hashFixtureInputs,
  sceneInputEnv,
  sceneInputPatterns,
} from '../tests/integration/support/fixture-inputs.ts';

const packageRoot = resolve(import.meta.dir, '..');

const bundle = async (entry: string, label: string): Promise<string> => {
  const result = await Bun.build({ entrypoints: [resolve(packageRoot, entry)], target: 'browser', throw: false });
  const [artifact] = result.outputs;
  if (!result.success || artifact === undefined)
    throw new Error(`❌ ${label} did not build:\n${result.logs.join('\n')}`);
  return await artifact.text();
};

const at = Bun.argv.indexOf('--out');
const out = at === -1 ? undefined : Bun.argv[at + 1];
if (out === undefined || !isAbsolute(out)) throw new Error('❌ --out <absolute-directory> is required');

await mkdir(out, { recursive: true });
const entryAt = Bun.argv.indexOf('--entry');
const entry = entryAt === -1 ? 'tests/integration/fixtures/composer-editor-scene.tsx' : Bun.argv[entryAt + 1];
if (entry === undefined) throw new Error('❌ --entry needs a path');

const cacheRoot =
  process.env.FY_FIXTURE_CACHE === 'off'
    ? undefined
    : cacheRootFor(
        await hashFixtureInputs({
          workspace: resolve(packageRoot, '../..'),
          patterns: sceneInputPatterns,
          env: sceneInputEnv(),
        }),
      );

/** `make()`'s text, from the cache when this key already made it. */
const cached = async (name: string, make: () => Promise<string>): Promise<string> =>
  cacheRoot === undefined ? await make() : await cachedText(cacheRoot, name, make);

// Bun inlines the `@import` graph; Tailwind then expands `@tailwind` exactly as the Vite build does,
// so utility classes (`hidden`, `sr-only`, …) behave as they ship.
const css = await cached('app.css', async () => {
  const imported = await bundle('src/styles/index.css', 'the app stylesheet');
  return (
    await postcss([tailwindcss(tailwindConfig)]).process(imported, {
      from: resolve(packageRoot, 'src/styles/index.css'),
    })
  ).css;
});
const js = await cached(`${entry.replace(/[^A-Za-z0-9.-]/gu, '_')}.js`, () => bundle(entry, `the scene ${entry}`));
const manifest = { css: resolve(out, 'app.css'), js: resolve(out, 'app.js') };
await writeFile(manifest.css, css, 'utf8');
await writeFile(manifest.js, js, 'utf8');
console.log(JSON.stringify(manifest));
