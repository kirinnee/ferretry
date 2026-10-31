/**
 * The stylesheet the two theme-picker shell suites render against: Tailwind compiled from
 * `src/styles/index.css` with the shipped config, scanning `src` AND the shell suites themselves (the
 * verbatim kteam reference markup in `theme-picker.visual.test.tsx` uses classes only it names).
 *
 * BUILT ONCE PER KEY, like `scripts/build-composer-integration-fixture.ts`: both suites asked for
 * the identical compile, ~3 s of the Tailwind CLI each. The output is kept under the run's temporary
 * directory, keyed by a hash of everything the compile can read, recomputed on every ask; a changed input is a new key.
 * `FY_FIXTURE_CACHE=off` compiles every time.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cachedText, cacheRootFor, hashFixtureInputs } from './fixture-inputs.ts';

const packageDir = resolve(import.meta.dir, '../../..');
const workspaceDir = resolve(packageDir, '../..');

const compile = async (): Promise<string> => {
  const scratch = await mkdtemp(join(tmpdir(), 'fy-shell-css-'));
  try {
    const outFile = join(scratch, 'app.css');
    const result = spawnSync(
      './node_modules/.bin/tailwindcss',
      [
        '--config',
        'tailwind.config.ts',
        '--input',
        'src/styles/index.css',
        '--output',
        outFile,
        '--content',
        './src/**/*.{ts,tsx},./tests/integration/shell/*.tsx',
      ],
      { cwd: packageDir, stdio: 'pipe' },
    );
    if (result.status !== 0) throw new Error(`tailwind build failed: ${result.stderr?.toString() ?? ''}`);
    return await readFile(outFile, 'utf8');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

const inputPatterns: readonly string[] = [
  'packages/*/src/**',
  'packages/pwa/tests/integration/shell/*.tsx',
  'packages/pwa/*.config.ts',
  'packages/pwa/package.json',
  'bun.lock',
];

export const shellCss = async (): Promise<string> => {
  if (process.env.FY_FIXTURE_CACHE === 'off') return await compile();
  const key = await hashFixtureInputs({ workspace: workspaceDir, patterns: inputPatterns });
  return await cachedText(cacheRootFor(key), 'shell-theme-picker.css', compile);
};
