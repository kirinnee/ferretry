/**
 * Builds one real-browser scene for a plugin app half's visual test: the app's stylesheet (through Tailwind, as Vite
 * builds it) and the scene named by `--entry <path>`, written to `--out <dir>`. Ported from today's PWA
 * `scripts/build-composer-integration-fixture.ts`; `sceneBuilder` (index.ts) is its path.
 *
 * A CHILD PROCESS, never a `Bun.build` inside the test runner: a component-graph build in the runner
 * is what wedged the two-file integration run (see `build-fy-render-integration-fixture.ts`).
 *
 * Prints one JSON line naming the two files.
 *
 * `--entry` is relative to the test's working directory (each plugin keeps its scenes beside its tests); there is no
 * default scene.
 *
 * THE PAGE'S STYLESHEET IS THE ONE THE REAL APP LOADS: `styles/index.css` (which carries every plugin app half's
 * `app/styles.css` through `generated/plugin-styles.css`), then `ui/design-system.css` (the shared component
 * classes, as `main.tsx` loads them), then the CSS the scene's own bundle imports (a component that imports its
 * stylesheet, as Vite would emit it). One pass through Tailwind. A scene never inlines CSS of its own.
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
import { isAbsolute, relative, resolve } from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { cachedText, cacheRootFor, hashFixtureInputs, sceneInputEnv, sceneInputPatterns } from './fixture-inputs.ts';
import { sceneTailwindConfig } from './scene-tailwind.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const workspace = resolve(packageRoot, '../..');

/** What a Bun build made: the script and, when the entry's graph imports stylesheets, their CSS (in import order). */
const bundleOf = async (entry: string, label: string): Promise<{ readonly js: string; readonly css: string }> => {
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', throw: false });
  if (!result.success) throw new Error(`❌ ${label} did not build:\n${result.logs.join('\n')}`);
  const sheets = result.outputs.filter(output => output.path.endsWith('.css'));
  const script = result.outputs.find(output => output.path.endsWith('.js'));
  if (script === undefined) throw new Error(`❌ ${label} made no script`);
  return { js: await script.text(), css: (await Promise.all(sheets.map(sheet => sheet.text()))).join('\n') };
};

/** A stylesheet entry with its `@import` graph inlined. */
const stylesheet = async (entry: string, label: string): Promise<string> => {
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', throw: false });
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
const asked = entryAt === -1 ? undefined : Bun.argv[entryAt + 1];
if (asked === undefined) throw new Error('❌ --entry <path> is required');
// Relative to the asking test's working directory: each plugin's scenes live beside its own tests.
const entry = resolve(process.cwd(), asked);

const cacheRoot =
  process.env.FY_FIXTURE_CACHE === 'off'
    ? undefined
    : cacheRootFor(
        await hashFixtureInputs({
          workspace,
          patterns: sceneInputPatterns,
          env: sceneInputEnv(),
        }),
      );

/** `make()`'s text, from the cache when this key already made it. */
const cached = async (name: string, make: () => Promise<string>): Promise<string> =>
  cacheRoot === undefined ? await make() : await cachedText(cacheRoot, name, make);

// Bun inlines the `@import` graph; Tailwind then expands `@tailwind` exactly as the Vite build does,
// so utility classes (`hidden`, `sr-only`, …) behave as they ship. Its content globs are anchored to `packages/app`
// (`scene-tailwind.ts`): this runs in the asking plugin's folder, where they would match nothing.
// `styles/index.css` carries every plugin's `app/styles.css`; none of the plugin sheets or `design-system.css` has a Tailwind directive, so they follow the
// processed index in the order `main.tsx` loads them.
const css = await cached('app.css', async () => {
  const index = resolve(packageRoot, 'src/styles/index.css');
  const imported = await stylesheet(index, 'the app stylesheet');
  const processed = (await postcss([tailwindcss(sceneTailwindConfig)]).process(imported, { from: index })).css;
  const designSystem = await stylesheet(
    resolve(packageRoot, 'src/ui/design-system.css'),
    'the design system stylesheet',
  );
  return `${processed}\n${designSystem}`;
});
const sceneName = relative(workspace, entry).replace(/[^A-Za-z0-9.-]/gu, '_');
let built: ReturnType<typeof bundleOf> | undefined;
const scene = (): ReturnType<typeof bundleOf> => (built ??= bundleOf(entry, `the scene ${entry}`));
const js = await cached(`${sceneName}.js`, async () => (await scene()).js);
const sceneCss = await cached(`${sceneName}.css`, async () => (await scene()).css);
const manifest = { css: resolve(out, 'app.css'), js: resolve(out, 'app.js') };
await writeFile(manifest.css, `${css}\n${sceneCss}`, 'utf8');
await writeFile(manifest.js, js, 'utf8');
console.log(JSON.stringify(manifest));
