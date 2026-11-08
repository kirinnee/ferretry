import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHost, classifyConnectError } from '../../../host/check.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';

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

test('V-0506 R689 --check on a missing home reports it would create one, creates nothing and leaves the port free', () => {
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

test('V-0506 R689 --check on an existing home leaves every entry untouched', () => {
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

test('V-0506 R689 --check refuses 78 for a home that is not a Ferretry home and touches nothing', () => {
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

test('V-0506 R689 --check exits 69 when something that is not this daemon holds the port', () => {
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

test('V-0506 R689 --check exits 78 and says `taken — another fyd, pid N` when a live fyd recorded this port', () => {
  const parent = mkdtempSync(join(tmpdir(), 'fyd-check-'));
  parents.push(parent);
  const home = join(parent, 'home');
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(join(home, 'home.json'), `${JSON.stringify({ format: 1, createdBy: 'test', createdAt: '2026-01-01T00:00:00.000Z' })}\n`);
  const holder = Bun.serve({ port: 0, fetch: () => new Response('') });
  try {
    const port = holder.port as number;
    writeFileSync(
      join(home, 'run/daemon.json'),
      `${JSON.stringify({ format: 1, socket: join(home, 'run/fyd.sock'), host: '127.0.0.1', port, pid: process.pid, version: '5.0.0' })}\n`,
    );
    const answer = check(home, port);
    expect(answer.code).toBe(78);
    expect(answer.out).toContain(`taken — another fyd, pid ${process.pid}`);
    expect(answer.out).toContain('fy daemon stop');
  } finally {
    void holder.stop(true);
  }
});

test('V-0506 R689 --check with port 0 says the operating system will assign the port and exits 0', () => {
  const parent = mkdtempSync(join(tmpdir(), 'fyd-check-'));
  parents.push(parent);
  const answer = check(join(parent, 'home'), 0);
  expect(answer.code).toBe(0);
  expect(answer.out).toContain('the operating system will assign the port');
});

test('V-0506 R689 a connect error is classified: refused is free, address-class is unusable, anything else is held', () => {
  expect(classifyConnectError('ECONNREFUSED')).toBe('free');
  for (const code of ['EADDRNOTAVAIL', 'ENETUNREACH', 'EACCES', 'ENOTFOUND']) {
    expect(classifyConnectError(code)).toBe('unusable');
  }
  for (const code of ['ECONNRESET', undefined]) expect(classifyConnectError(code)).toBe('held');
});

test('V-0506 R689 --check says an unreachable host cannot be reached from this machine and exits 78, not 69', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'fyd-check-'));
  parents.push(parent);
  const lines: string[] = [];
  const code = await checkHost({
    fs: nodeFs(() => crypto.randomUUID()),
    home: join(parent, 'home'),
    host: 'no-such-host.invalid',
    port: 7457,
    daemonName: 'fyd',
    probe: async () => 'unusable',
    alive: () => false,
    say: line => void lines.push(line),
  });
  expect(code).toBe(78);
  expect(lines.join('\n')).toContain('! no-such-host.invalid cannot be reached from this machine');
  expect(lines.join('\n')).not.toContain('not a fyd');
});
