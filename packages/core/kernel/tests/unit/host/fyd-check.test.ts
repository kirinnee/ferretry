import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `fyd --check` (R689) reports whether the daemon would start and exits WITHOUT creating, locking or binding anything:
 * the home is byte-for-byte as it was and the port stays free.
 */
const FYD = join(import.meta.dir, '../../../host/fyd.ts');
const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port as number;
  void server.stop(true);
  return port;
}

function check(home: string, port: number, ...extra: string[]) {
  const child = Bun.spawnSync(['bun', FYD, '--check', ...extra], {
    env: { ...process.env, FY_HOME: home, FY_PORT: String(port) },
    timeout: 20_000,
  });
  return { code: child.exitCode, out: child.stdout.toString() };
}

const snapshot = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).map(
    entry => `${join(entry.parentPath, entry.name)}:${statSync(join(entry.parentPath, entry.name)).mtimeMs}`,
  );

test('R689 --check on a missing home reports it would create one, creates nothing and leaves the port free', () => {
  const parent = mkdtempSync(join(tmpdir(), 'fyd-check-'));
  parents.push(parent);
  const home = join(parent, 'home');
  const port = freePort();
  const answer = check(home, port);
  expect(answer.code).toBe(0);
  expect(answer.out).toContain('would create it');
  expect(answer.out).toContain('free — this daemon would bind it');
  expect(existsSync(home)).toBe(false);
  const probe = Bun.serve({ port, fetch: () => new Response('') });
  void probe.stop(true);
});

test('R689 --check on an existing home leaves every entry untouched', () => {
  const parent = mkdtempSync(join(tmpdir(), 'fyd-check-'));
  parents.push(parent);
  const home = join(parent, 'home');
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(join(home, 'home.json'), `${JSON.stringify({ format: 1, createdBy: 'test', createdAt: '2026-01-01T00:00:00.000Z' })}\n`);
  const before = snapshot(home);
  const answer = check(home, freePort());
  expect(answer.code).toBe(0);
  expect(answer.out).toContain('a Ferretry home');
  expect(snapshot(home)).toEqual(before);
});

test('R689 --check refuses 78 for a home that is not a Ferretry home and touches nothing', () => {
  const parent = mkdtempSync(join(tmpdir(), 'fyd-check-'));
  parents.push(parent);
  const home = join(parent, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'stray.txt'), 'x');
  const before = snapshot(home);
  const answer = check(home, freePort());
  expect(answer.code).toBe(78);
  expect(snapshot(home)).toEqual(before);
});

test('R689 --check exits 69 when something that is not this daemon holds the port', () => {
  const parent = mkdtempSync(join(tmpdir(), 'fyd-check-'));
  parents.push(parent);
  const holder = Bun.serve({ port: 0, fetch: () => new Response('') });
  try {
    const answer = check(join(parent, 'home'), holder.port as number);
    expect(answer.code).toBe(69);
    expect(answer.out).toContain('not a fyd');
  } finally {
    void holder.stop(true);
  }
});
