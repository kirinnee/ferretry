/**
 * Builds one scene as a SPLIT bundle (an entry and its lazy chunks), in a CHILD PROCESS into `--out <absolute-dir>`, and
 * prints one JSON line: `{ "entry": "<file>", "chunks": ["<file>", …] }`, names relative to the directory.
 *
 * WHY NOT THE SHARED SCENE BUILDER. `@ferretry/app/testing/browser`'s builder makes ONE script, with every dynamic
 * `import()` folded in, which is right for a picture and wrong for a claim about WHEN a module is fetched. The 3D stage of an
 * animation is a lazy module (decision C4: "no 3D chunk request on a page without a 3D block"), and only a split build has
 * a chunk to be requested or not. Bun's `splitting` makes one per `import()`.
 *
 * A child, never `Bun.build` in the test runner (`build-fy-render-integration-fixture.ts` says why).
 * `--first <absolute-module>` (optional) is built ALONE, with no splitting, as `first.js`, for a page to load as a module script
 * BEFORE `scene.js`. Bun's splitting runs the code of shared chunks before the entry's own body, so a module imported first by
 * the scene (the app's `zod-jitless`, which must run before any schema is built) would run after the schemas of every shared
 * chunk; as its own script it runs first, the way the app's real build orders it.
 * Usage: `bun hypermedia-split-build.ts --out <absolute-dir> --entry <absolute-scene> [--first <absolute-module>]`.
 */
import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
const argument = (name: string): string => {
  const at = Bun.argv.indexOf(name);
  const value = at === -1 ? undefined : Bun.argv[at + 1];
  if (value === undefined || !isAbsolute(value)) throw new Error(`❌ ${name} <absolute-path> is required`);
  return value;
};

const out = argument('--out');
const entry = argument('--entry');
const conversation = resolve(import.meta.dir, '../../../..');

/**
 * Vite's asset queries (`x.wasm?url`) are the bundler's own: a scene runs no on-device engine, so each is an empty URL. The ONE
 * exception is the Durian worker (r12 H11): its URL is where the test's server serves the chunk it built the app's way
 * (`/assets/durian-worker-test.js`, a name the page's real Trusted Types policy accepts), so the page starts it through the
 * production code (`durian-spawn.ts`) under the real policy.
 */
const DURIAN_WORKER_URL = '/assets/durian-worker-test.js';
const viteAssetUrls: Bun.BunPlugin = {
  name: 'vite-asset-urls',
  setup(build) {
    build.onResolve({ filter: /\?(worker&)?url$/u }, args => ({ path: args.path, namespace: 'vite-asset-url' }));
    build.onLoad({ filter: /.*/u, namespace: 'vite-asset-url' }, args => ({
      contents: `export default '${args.path.includes('durian-worker.ts') ? DURIAN_WORKER_URL : ''}';`,
      loader: 'js',
    }));
  },
};

/** `durian-markdown` arrives as source under the `bun` condition; a browser-target build does not read it (see `build-scene.ts`). */
const durianSource: Bun.BunPlugin = {
  name: 'durian-markdown-source',
  setup(build) {
    build.onResolve({ filter: /^durian-markdown(?:\/[a-z/-]+)?$/u }, args => ({
      path: Bun.resolveSync(args.path, conversation),
    }));
  },
};

await mkdir(out, { recursive: true });
const result = await Bun.build({
  entrypoints: [entry],
  outdir: out,
  target: 'browser',
  format: 'esm',
  splitting: true,
  throw: false,
  plugins: [viteAssetUrls, durianSource],
  naming: { entry: 'scene.[ext]', chunk: 'chunk-[hash].js', asset: '[name]-[hash].[ext]' },
  metafile: true,
} as Bun.BuildConfig);
if (!result.success) throw new Error(`❌ the split scene did not build:\n${result.logs.join('\n')}`);
if (Bun.argv.includes('--first')) {
  const first = await Bun.build({
    entrypoints: [argument('--first')],
    outdir: out,
    target: 'browser',
    format: 'esm',
    throw: false,
    naming: { entry: 'first.[ext]' },
  });
  if (!first.success) throw new Error(`❌ the first script did not build:\n${first.logs.join('\n')}`);
}
const files = result.outputs.map(output => relative(out, output.path)).filter(name => name.endsWith('.js'));
const inputs = Object.keys((result as unknown as { metafile: { inputs: Record<string, unknown> } }).metafile.inputs);
console.log(JSON.stringify({ entry: 'scene.js', chunks: files.filter(name => name !== 'scene.js'), inputs }));
