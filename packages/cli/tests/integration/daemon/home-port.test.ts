import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * COMPOSED: the real `fy` drives the real `fyd` on a temp FY_HOME whose configuration names a free, non-default port.
 * `fy daemon start` then `fy daemon restart` must bind THAT port (the home's own, `config/connections.yaml`
 * `direct.port`) and never 7457, and `fy` must find it there. No service manager is installed (a temp HOME), so the
 * direct supervisor starts the daemon; no FY_PORT is passed anywhere. Loopback, a port the OS just handed out, fake home.
 */
const ROOT = join(import.meta.dir, '../../../../..');
const FY = join(ROOT, 'packages/cli/bin/fy.ts');
const FYD = join(ROOT, 'packages/core/kernel/host/fyd.ts');
const DEFAULT_PORT = 7457;

let root: string;
let home: string;
let port: number;
let env: Record<string, string>;

/**
 * A port nobody guessed: a throwaway daemon is asked for port 0 (`FY_PORT=0`), the port it RECORDS is the one the OS
 * chose, and it is stopped. That number is then written into the home's own configuration for the real run.
 */
async function portTheOsChose(wrapper: string, environment: Record<string, string>): Promise<number> {
  const child = Bun.spawn({
    cmd: [wrapper],
    env: { ...environment, FY_PORT: '0' },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  try {
    for (let waited = 0; waited < 90_000; waited += 200) {
      try {
        return (JSON.parse(await readFile(join(home, 'run/daemon.json'), 'utf8')) as { port: number }).port;
      } catch {
        if (child.exitCode !== null) throw new Error(`the throwaway fyd exited ${String(child.exitCode)}`);
        await Bun.sleep(200);
      }
    }
    throw new Error('the throwaway fyd recorded no port');
  } finally {
    child.kill('SIGTERM');
    await child.exited;
  }
}

async function fy(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, FY, ...args],
    cwd: ROOT,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

async function runRecord(): Promise<{ port: number; pid: number }> {
  return JSON.parse(await readFile(join(home, 'run/daemon.json'), 'utf8')) as { port: number; pid: number };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-home-port-'));
  home = join(root, 'fy-home');
  const userHome = join(root, 'user-home');
  await mkdir(join(home, 'config'), { recursive: true });
  await mkdir(userHome, { recursive: true });
  await writeFile(
    join(home, 'home.json'),
    JSON.stringify({ format: 1, createdBy: 'cli-home-port-test', createdAt: '2026-11-14T00:00:00.000Z' }),
  );
  // `fy daemon start` looks for `fyd` on PATH, and `restart` for the same: the only one on THIS PATH is the real 5.0
  // fyd below, kept offline. The machine's own PATH is not inherited, so an installed (v4) fyd can never be launched.
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const wrapper = join(bin, 'fyd');
  await writeFile(
    wrapper,
    `#!/bin/sh\nexport FY_RELAY_DIRECTORY_ORIGIN=off FY_UPDATE_CHECK=off FY_MODEL_CATALOG=off FY_LOCAL_MODELS=off FYD_BACKGROUND_DELAY_SECONDS=3600\nexec '${process.execPath}' '${FYD}' "$@"\n`,
    { mode: 0o755 },
  );
  env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: userHome,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C.UTF-8',
    FY_HOME: home,
    XDG_CONFIG_HOME: join(userHome, '.config'),
    XDG_STATE_HOME: join(userHome, '.local/state'),
    XDG_RUNTIME_DIR: join(root, 'run'),
    FY_UPDATE_CHECK: 'off',
  };
  port = await portTheOsChose(wrapper, env);
  expect(port).not.toBe(DEFAULT_PORT);
  await writeFile(join(home, 'config/connections.yaml'), `direct:\n  host: 127.0.0.1\n  port: ${String(port)}\n`);
});

afterAll(async () => {
  await fy('daemon', 'stop');
  await rm(root, { recursive: true, force: true });
});

describe('a home that configures its own daemon port', () => {
  test('fy daemon start binds the home’s port, and fy finds the daemon there', async () => {
    const started = await fy('daemon', 'start');
    expect(started.code, started.err + started.out).toBe(0);
    expect((await runRecord()).port).toBe(port);
    const status = await fy('daemon', 'status');
    expect(status.code, status.err + status.out).toBe(0);
    expect(status.out + status.err).toContain(String(port));
    expect(status.out + status.err).not.toContain(String(DEFAULT_PORT));
  }, 120_000);

  test('fy daemon restart binds the same port again, a new process, never 7457', async () => {
    const before = await runRecord();
    const restarted = await fy('daemon', 'restart');
    expect(restarted.code, restarted.err + restarted.out).toBe(0);
    const after = await runRecord();
    expect(after.port).toBe(port);
    expect(after.pid).not.toBe(before.pid);
    expect(after.port).not.toBe(DEFAULT_PORT);
  }, 120_000);

  test('fy daemon stop, then with no run record fy still looks at the home’s port', async () => {
    const stopped = await fy('daemon', 'stop');
    expect(stopped.code, stopped.err + stopped.out).toBe(0);
    const status = await fy('daemon', 'status');
    expect(status.out + status.err).toContain(String(port));
    expect(status.out + status.err).not.toContain(String(DEFAULT_PORT));
  }, 120_000);
});
