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
 * BUILT ONCE PER TEST RUN. About twenty visual test files each asked for a build of their own, ~3.3 s
 * apiece, almost all of it the same Tailwind stylesheet. Each output is now kept under the run's
 * temporary directory (`scripts/test/swept.sh` gives every run its own), keyed by a hash (itself kept for the run) of everything
 * a build can read: this package's sources and fixtures, every workspace package's `src`, the Tailwind
 * and Vite configs and the lockfile. The stylesheet is shared by every scene; a scene's bundle by every
 * file that asks for it. A changed input is a new key, so a hit is always a build of the same inputs.
 * Writes land through a rename, so two test processes asking at once never read half a file.
 * `FY_FIXTURE_CACHE=off` builds every time.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '../tailwind.config.ts';

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

/** A hash of every file a build can read, in a fixed order. */
const inputsHash = async (): Promise<string> => {
  const workspace = resolve(packageRoot, '../..');
  const hasher = new Bun.CryptoHasher('sha256');
  const patterns = [
    'packages/*/src/**',
    'packages/pwa/tests/integration/fixtures/**',
    'packages/pwa/*.config.ts',
    'packages/pwa/scripts/build-composer-integration-fixture.ts',
    'bun.lock',
  ];
  const files: string[] = [];
  for (const pattern of patterns)
    for await (const file of new Bun.Glob(pattern).scan({ cwd: workspace, onlyFiles: true })) files.push(file);
  for (const file of files.sort()) {
    hasher.update(file);
    hasher.update(new Uint8Array(await Bun.file(join(workspace, file)).arrayBuffer()));
  }
  return hasher.digest('hex').slice(0, 24);
};

/**
 * The inputs hash itself is kept for the run too: reading ~22 MB of sources to hash them cost about as much
 * as a cache hit saves, once per scene. Sources do not change mid-run, and the run's temporary directory is
 * its own, so a hash written once stays true.
 */
const knownInputsHash = async (): Promise<string> => {
  const directory = join(tmpdir(), 'ferretry-fixture-cache');
  const path = join(directory, 'inputs.hash');
  const hit = (await readFile(path, 'utf8').catch(() => '')).trim();
  if (hit !== '') return hit;
  const hash = await inputsHash();
  await mkdir(directory, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, hash, 'utf8');
  await rename(partial, path);
  return hash;
};

const cacheRoot =
  process.env.FY_FIXTURE_CACHE === 'off'
    ? undefined
    : join(tmpdir(), 'ferretry-fixture-cache', await knownInputsHash());

/** `make()`'s text, from the cache when this run already made it. */
const cached = async (name: string, make: () => Promise<string>): Promise<string> => {
  if (cacheRoot === undefined) return await make();
  const path = join(cacheRoot, name);
  const hit = await readFile(path, 'utf8').catch(() => undefined);
  if (hit !== undefined) return hit;
  const text = await make();
  await mkdir(cacheRoot, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, text, 'utf8');
  await rename(partial, path);
  return text;
};

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
