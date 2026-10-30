/**
 * The stylesheet the two theme-picker shell suites render against: Tailwind compiled from
 * `src/styles/index.css` with the shipped config, scanning `src` AND the shell suites themselves (the
 * verbatim kteam reference markup in `theme-picker.visual.test.tsx` uses classes only it names).
 *
 * BUILT ONCE PER TEST RUN, like `scripts/build-composer-integration-fixture.ts`: both suites asked for
 * the identical compile, ~3 s of the Tailwind CLI each. The output is kept under the run's temporary
 * directory, keyed by a hash of everything the compile can read; a changed input is a new key.
 * `FY_FIXTURE_CACHE=off` compiles every time.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageDir = resolve(import.meta.dir, '../../..');
const workspaceDir = resolve(packageDir, '../..');

const inputsHash = async (): Promise<string> => {
  const hasher = new Bun.CryptoHasher('sha256');
  const patterns = [
    'packages/*/src/**',
    'packages/pwa/tests/integration/shell/*.tsx',
    'packages/pwa/*.config.ts',
    'packages/pwa/package.json',
    'bun.lock',
  ];
  const files: string[] = [];
  for (const pattern of patterns)
    for await (const file of new Bun.Glob(pattern).scan({ cwd: workspaceDir, onlyFiles: true })) files.push(file);
  for (const file of files.sort()) {
    hasher.update(file);
    hasher.update(new Uint8Array(await Bun.file(join(workspaceDir, file)).arrayBuffer()));
  }
  return hasher.digest('hex').slice(0, 24);
};

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

export const shellCss = async (): Promise<string> => {
  if (process.env.FY_FIXTURE_CACHE === 'off') return await compile();
  const root = join(tmpdir(), 'ferretry-fixture-cache', await inputsHash());
  const path = join(root, 'shell-theme-picker.css');
  const hit = await readFile(path, 'utf8').catch(() => undefined);
  if (hit !== undefined) return hit;
  const css = await compile();
  await mkdir(root, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, css, 'utf8');
  await rename(partial, path);
  return css;
};
