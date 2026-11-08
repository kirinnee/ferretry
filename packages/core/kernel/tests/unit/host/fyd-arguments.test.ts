import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `fyd` answers its command line BEFORE anything with a side effect: `--version` and `--help` touch nothing, an unknown
 * argument is refused 64 with the usage, and a mode this daemon does not serve yet is refused, never ignored.
 */
const FYD = join(import.meta.dir, '../../../host/fyd.ts');
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function run(...argv: string[]) {
  const parent = mkdtempSync(join(tmpdir(), 'fyd-arguments-'));
  homes.push(parent);
  const home = join(parent, 'home');
  const child = Bun.spawnSync(['bun', FYD, ...argv], { env: { ...process.env, FY_HOME: home }, timeout: 20_000 });
  return {
    code: child.exitCode,
    out: child.stdout.toString(),
    err: child.stderr.toString(),
    touched: existsSync(home),
  };
}

test('fyd --version prints the version, exits 0 and creates no home', () => {
  const answer = run('--version');
  expect(answer.code).toBe(0);
  expect(answer.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  expect(answer.touched).toBe(false);
});

test('fyd --help prints the usage and creates no home', () => {
  const answer = run('--help');
  expect(answer.code).toBe(0);
  expect(answer.out).toContain('Exit codes:');
  expect(answer.touched).toBe(false);
});

test('an unknown argument is refused 64 with the usage, before boot', () => {
  const answer = run('--bogus');
  expect(answer.code).toBe(64);
  expect(answer.err).toContain('is not an option this daemon has');
  expect(answer.touched).toBe(false);
});

test('a mode this daemon does not serve yet is refused 64, never ignored', () => {
  for (const argv of [['--host', '0.0.0.0'], ['--log-level', 'warn']]) {
    const answer = run(...argv);
    expect(answer.code).toBe(64);
    expect(answer.err).toContain('is not served by this daemon yet');
    expect(answer.touched).toBe(false);
  }
});
