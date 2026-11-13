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

test('V-0513 fyd --version prints the version, exits 0 and creates no home', () => {
  const answer = run('--version');
  expect(answer.code).toBe(0);
  expect(answer.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  expect(answer.touched).toBe(false);
});

test('V-0508 fyd --help prints the usage and creates no home', () => {
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

test('V-0511 --port sets the port for one run, and a value that is not a port number is refused 64', () => {
  const ok = run('--print-config', '--port', '9123');
  expect(ok.code).toBe(0);
  expect(ok.out).toMatch(/port\s+9123\s+flag \(--port\)/);
  expect(ok.touched).toBe(false);
  for (const bad of ['abc', '0', '70000']) {
    const refused = run('--print-config', '--port', bad);
    expect(refused.code).toBe(64);
    expect(refused.err).toContain('is not a port number');
    expect(refused.touched).toBe(false);
  }
});
