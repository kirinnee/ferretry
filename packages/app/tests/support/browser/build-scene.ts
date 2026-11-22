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
import { readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { cachedText, cacheRootFor, hashFixtureInputs, sceneInputEnv, sceneInputPatterns } from './fixture-inputs.ts';
import { textScalePostcss } from '../../../scripts/text-scale-postcss.ts';
import { legacyThemeBanner } from './legacy-theme-shim.ts';
import { sceneTailwindConfig } from './scene-tailwind.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const workspace = resolve(packageRoot, '../..');

/**
 * Vite's asset queries (`x.wasm?url`, `worker.ts?worker&url`) are the bundler's own: Voice's `speech-assets.ts` names eight
 * of them, and a scene that bundles the generated surfaces reaches that module through Voice's lazy import. A scene never
 * runs an on-device engine, so each query resolves to an empty URL here (the real build emits the files; `vite.config.ts`).
 */
const viteAssetUrls: Bun.BunPlugin = {
  name: 'vite-asset-urls',
  setup(build) {
    build.onResolve({ filter: /\?(worker&)?url$/u }, args => ({ path: args.path, namespace: 'vite-asset-url' }));
    build.onLoad({ filter: /.*/u, namespace: 'vite-asset-url' }, () => ({
      contents: "export default '';",
      loader: 'js',
    }));
  },
};

/**
 * A plugin half loads a view by a Vite dynamic-import variable, an `import()` of a template literal such as
 * `./views/${name}.tsx`, which Vite expands to every file the pattern matches and Bun cannot. This writes the same
 * expansion (one literal `import()` per matching file in the folder), so a scene over the REAL generated surfaces draws
 * the real views instead of "stopped working".
 */
const viteDynamicImports: Bun.BunPlugin = {
  name: 'vite-dynamic-import-variables',
  setup(build) {
    build.onLoad({ filter: /\/(?:plugins|core)\/[^/]+\/app\/.*\.tsx?$/u }, async args => {
      const source = await Bun.file(args.path).text();
      const pattern = /import\(`(\.\/[^`$]*)\$\{([^}]+)\}(\.tsx?)`\)/gu;
      if (!source.match(pattern)) return undefined;
      const contents = source.replace(pattern, (_whole, prefix: string, expression: string, extension: string) => {
        const folder = resolve(dirname(args.path), prefix);
        const names = readdirSync(folder)
          .filter(name => name.endsWith(extension))
          .map(name => name.slice(0, -extension.length));
        const cases = names
          .map(
            name => `case ${JSON.stringify(name)}: return import(${JSON.stringify(`${prefix}${name}${extension}`)});`,
          )
          .join(' ');
        return `((__view) => { switch (__view) { ${cases} default: return Promise.reject(new Error('no view ' + __view)); } })(${expression})`;
      });
      return { contents, loader: args.path.endsWith('x') ? 'tsx' : 'ts' };
    });
  },
};

/**
 * `durian-hypermedia` (the hypermedia renderer) arrives as SOURCE: its `exports` map names the file under the `bun` condition
 * and a `dist/` its `prepare` script would build never exists (the install runs `--ignore-scripts`). Bun's own runtime reads that
 * condition, a browser-target build does not, and the root tsconfig points the specifier at a declaration file for the type
 * checker. So each import of the package, or of a React entry of it, is resolved the way the runtime reads it: to the source file.
 * (The stylesheet, `durian-hypermedia/styles.css`, is generated by the Vite build and is not part of a scene.)
 */
const durianSource: Bun.BunPlugin = {
  name: 'durian-hypermedia-source',
  setup(build) {
    build.onResolve({ filter: /^durian-hypermedia(?:\/[a-z/-]+)?$/u }, args => ({
      path: Bun.resolveSync(args.path, resolve(workspace, 'packages/plugins/conversation')),
    }));
  },
};

/**
 * THE DURIAN WORKER, FOR A SCENE (r12 H11). A message is read by a worker (`plugins/conversation/app/hypermedia/durian-worker.ts`),
 * which the real build emits as a hashed chunk and `durian-spawn.ts` starts under the page's Trusted Types policy. A scene has no
 * Vite and no policy, so `durian-spawn.ts` is replaced by a module that starts the SAME worker module, bundled here, from a blob URL.
 * Everything the worker does is the real thing; only where its script comes from is the scene's. (The scenes that prove the
 * real policy and the real chunk build the app's way: `tests/integration/app/hypermedia-csp.visual.test.ts`.)
 */
let durianWorkerCode: Promise<string> | undefined;
const durianWorkerSource = (): Promise<string> => {
  durianWorkerCode ??= (async () => {
    // A worker has no `document`: the entity decoder is its table build, not the `browser` condition's DOM one.
    const noDom: Bun.BunPlugin = {
      name: 'entity-decoder-without-dom',
      setup(build) {
        build.onResolve({ filter: /^decode-named-character-reference$/u }, args => ({
          path: Bun.resolveSync(args.path, args.importer).replace(/index\.dom\.js$/u, 'index.js'),
        }));
      },
    };
    const result = await Bun.build({
      entrypoints: [resolve(workspace, 'packages/plugins/conversation/app/hypermedia/durian-worker.ts')],
      target: 'browser',
      format: 'esm',
      throw: false,
      plugins: [durianSource, noDom],
    });
    const script = result.outputs.find(output => output.path.endsWith('.js'));
    if (!result.success || script === undefined)
      throw new Error(`❌ the Durian worker did not build:\n${result.logs.join('\n')}`);
    return script.text();
  })();
  return durianWorkerCode;
};

const durianWorkerForScenes: Bun.BunPlugin = {
  name: 'durian-worker-for-scenes',
  setup(build) {
    build.onResolve({ filter: /\/hypermedia\/durian-spawn\.ts$/u }, args => ({
      path: args.path,
      namespace: 'durian-spawn-for-scenes',
    }));
    build.onLoad({ filter: /.*/u, namespace: 'durian-spawn-for-scenes' }, async () => ({
      contents: `const code = ${JSON.stringify(await durianWorkerSource())};
let url;
export async function spawnDurianWorker() {
  url ??= URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  return new Worker(url, { type: 'module', name: 'fy-durian' });
}`,
      loader: 'js',
    }));
  },
};

/** What a Bun build made: the script and, when the entry's graph imports stylesheets, their CSS (in import order). */
const bundleOf = async (entry: string, label: string): Promise<{ readonly js: string; readonly css: string }> => {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    throw: false,
    plugins: [viteAssetUrls, viteDynamicImports, durianSource, durianWorkerForScenes],
    banner: legacyThemeBanner,
  });
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
// The app's Vite build runs the text-scale rule over EVERY sheet (`vite.config.ts`): so does the scene, or a Text size pick would not move a plugin's own type.
const scaledCss = (await postcss([textScalePostcss()]).process(`${css}\n${sceneCss}`, { from: undefined })).css;
await writeFile(manifest.css, scaledCss, 'utf8');
await writeFile(manifest.js, js, 'utf8');
console.log(JSON.stringify(manifest));
