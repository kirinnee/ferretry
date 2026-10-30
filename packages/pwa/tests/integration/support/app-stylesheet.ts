/**
 * THE APP STYLESHEET FOR THE STATIC-MARKUP VISUAL FILES, built once per test process.
 *
 * Seven files render a component to static markup and need the shipped stylesheet around it. Each ran the
 * Tailwind CLI itself, blocking the runner for ~2.5 s apiece; the input is the same for all of them (the
 * app's styles scanned over `src` and the feature scenes), so the first caller builds it and every later
 * caller awaits the same promise. The child is async, so nothing else in the process stands still while it
 * runs. A failed build is not remembered.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageDir = resolve(import.meta.dir, '../../..');

const build = async (): Promise<string> => {
  const workspace = await mkdtemp(join(tmpdir(), 'fy-app-stylesheet-'));
  try {
    const stylesheet = join(workspace, 'app.css');
    const child = Bun.spawn(
      [
        './node_modules/.bin/tailwindcss',
        '--config',
        'tailwind.config.ts',
        '--input',
        'src/styles/index.css',
        '--output',
        stylesheet,
        '--content',
        './src/**/*.{ts,tsx},./tests/integration/features/*.tsx',
      ],
      { cwd: packageDir, stderr: 'pipe', stdout: 'pipe' },
    );
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`tailwind build failed: ${stderr}`);
    return await readFile(stylesheet, 'utf8');
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
};

let shared: Promise<string> | undefined;

export const appStylesheet = (): Promise<string> => {
  if (shared !== undefined) return shared;
  const started = build();
  shared = started;
  started.catch(() => {
    if (shared === started) shared = undefined;
  });
  return started;
};
