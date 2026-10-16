/**
 * Builds the real-browser composer scene: the app's stylesheet (through Tailwind, as Vite builds it)
 * and `tests/integration/fixtures/composer-editor-scene.tsx`, written to `--out <dir>`.
 *
 * A CHILD PROCESS, never a `Bun.build` inside the test runner: a component-graph build in the runner
 * is what wedged the two-file integration run (see `build-fy-render-integration-fixture.ts`).
 *
 * Prints one JSON line naming the two files.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
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
// Bun inlines the `@import` graph; Tailwind then expands `@tailwind` exactly as the Vite build does,
// so utility classes (`hidden`, `sr-only`, …) behave as they ship.
const imported = await bundle('src/styles/index.css', 'the app stylesheet');
const css = (
  await postcss([tailwindcss(tailwindConfig)]).process(imported, { from: resolve(packageRoot, 'src/styles/index.css') })
).css;
const js = await bundle('tests/integration/fixtures/composer-editor-scene.tsx', 'the composer scene');
const manifest = { css: resolve(out, 'app.css'), js: resolve(out, 'app.js') };
await writeFile(manifest.css, css, 'utf8');
await writeFile(manifest.js, js, 'utf8');
console.log(JSON.stringify(manifest));
