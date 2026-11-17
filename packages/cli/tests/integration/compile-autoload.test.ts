/**
 * A binary the release compile script builds IGNORES the working directory's `bunfig.toml` and `.env`.
 *
 * WHY THIS MATTERS. A Bun standalone loads both from its cwd by default, so `fy` run inside a repository
 * with a top-level bunfig `preload` ran THAT repository's code inside fy, and a repository's `.env`
 * silently rewrote fy's environment (F4316, found by a strict review of PR 1778 against a binary built by
 * `scripts/release/compile-executable.ts` and against the installed 4.x `fy`). `compile-executable.ts` is the
 * one place every `fy` and `fyd` is compiled, so one real run of it over a tiny entry proves them all.
 *
 * The scene: a scratch directory holds a `bunfig.toml` whose `preload` writes a marker file and a `.env` that
 * sets `FY_PROBE`; the compiled probe is run from there and must see neither. Compiling the tiny entry takes
 * well under a second, so this stays in the integration tier.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const compileScript = resolve(import.meta.dir, '../../../../scripts/release/compile-executable.ts');

let scratch = '';
let cwd = '';
let binary = '';

/** The environment a child starts with: ours, minus anything that could stand in for the cwd files. */
const cleanEnvironment = (): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'FY_PROBE' && !key.startsWith('BUN_')) environment[key] = value;
  }
  return environment;
};

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'compile-autoload-'));
  cwd = join(scratch, 'cwd');
  binary = join(scratch, 'probe');
  const entry = join(scratch, 'entry');
  await mkdir(cwd);
  await mkdir(entry);
  await writeFile(join(entry, 'probe.ts'), 'console.log(JSON.stringify({ probe: process.env.FY_PROBE ?? null }));\n');
  await writeFile(join(cwd, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
  await writeFile(
    join(cwd, 'pre.ts'),
    'import { writeFileSync } from "node:fs";\nwriteFileSync("./preload-ran", "yes");\n',
  );
  await writeFile(join(cwd, '.env'), 'FY_PROBE=1\n');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('a compiled binary and the directory it is run from', () => {
  test('does not run the cwd bunfig preload and does not read the cwd .env', async () => {
    const compile = Bun.spawnSync(
      [process.execPath, compileScript, '--entry', join(scratch, 'entry', 'probe.ts'), '--outfile', binary],
      { cwd: scratch, env: cleanEnvironment(), stdout: 'pipe', stderr: 'pipe' },
    );
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);

    const run = Bun.spawnSync([binary], { cwd, env: cleanEnvironment(), stdout: 'pipe', stderr: 'pipe' });

    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(existsSync(join(cwd, 'preload-ran'))).toBe(false);
    expect(JSON.parse(run.stdout.toString())).toEqual({ probe: null });
  });
});
