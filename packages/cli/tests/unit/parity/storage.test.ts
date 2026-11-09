/**
 * The fy shell's own stored files among the Kernel-owned F rows of docs/design/rebuild-parity.tsv, each named by its
 * id: the claim directory a lifecycle command takes (F-0019, F-0020, F-0036, F-0037) and the daemon lock's place in
 * the state home (F-0042). A kernel test may not import the shell, so they are proved here; the generator points
 * their `check` at this file.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fsp from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDaemonLifecycleLock } from '../../../src/adapters/daemon/lifecycle-lock.ts';
import { resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import type { DaemonLifecycleClaimRequest, IClockPort, IDaemonProcessPort } from '../../../src/lib/daemon/ports.ts';

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fy-parity-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async dir => await rm(dir, { recursive: true, force: true })));
});

const clock: IClockPort = { now: () => 1_700_000_000_000, sleep: async () => await Promise.resolve() };
const processes: IDaemonProcessPort = {
  run: async () => await Promise.reject(new Error('unused')),
  spawnDetached: async () => await Promise.reject(new Error('unused')),
  signal: () => false,
  alive: () => false,
  holdsOpen: async () => await Promise.resolve(undefined),
};
const incarnations = {
  scope: async () => await Promise.resolve({ boot: 'boot-2', namespace: 'pid:[1]' }),
  observe: async () => await Promise.resolve({ kind: 'gone' as const }),
};

function request(lockPath: string, notes: string[] = []): DaemonLifecycleClaimRequest {
  return {
    lockPath,
    verb: 'start',
    waitMs: 100,
    waiting: holder => void notes.push(`waiting: ${holder}`),
    reclaimed: holder => void notes.push(`reclaimed: ${holder}`),
  };
}
const lock = () => new FileDaemonLifecycleLock(processes, incarnations, clock);

describe('the lifecycle claim', () => {
  test('F-0019 F-0020 a claim is built under .fy-daemon-lifecycle.<uuid>/claim-<token>.json beside the lock, then published as the lock', async () => {
    const root = await temp();
    const lockPath = join(root, 'run', 'daemon-lifecycle.lock');
    const written: string[] = [];
    const real = fsp.writeFile;
    const spy = spyOn(fsp, 'writeFile').mockImplementation(async (...args: Parameters<typeof real>) => {
      written.push(String(args[0]));
      return await real(...args);
    });
    const claim = await lock().acquire(request(lockPath));
    spy.mockRestore();
    const staged = written.find(path => path.includes('.fy-daemon-lifecycle.'));
    expect(staged).toMatch(
      new RegExp(
        `^${join(root, 'run').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.fy-daemon-lifecycle\\.[0-9a-f-]{36}/claim-[0-9a-f-]{36}\\.json$`,
      ),
    );
    // Published in one move: the staged directory is gone and the lock holds the claim file.
    expect((await readdir(join(root, 'run'))).filter(name => name.startsWith('.fy-daemon-lifecycle.'))).toEqual([]);
    expect((await readdir(lockPath)).filter(name => /^claim-[0-9a-f-]{36}\.json$/.test(name))).toHaveLength(1);
    await claim.release();
  });

  test('F-0037 releasing removes the holder’s own claim-<token>.json and the lock directory', async () => {
    const root = await temp();
    const lockPath = join(root, 'run', 'daemon-lifecycle.lock');
    const claim = await lock().acquire(request(lockPath));
    const name = (await readdir(lockPath))[0] ?? '';
    expect(name).toMatch(/^claim-[0-9a-f-]{36}\.json$/);
    expect(((await stat(join(lockPath, name))).mode & 0o777).toString(8)).toBe('600');
    expect(await claim.release()).toBeUndefined();
    expect(await stat(lockPath).catch(() => undefined)).toBeUndefined();
  });

  test('F-0036 a claim whose holder exited is cleared by its claim-<token>.json before a new one is taken', async () => {
    const root = await temp();
    const lockPath = join(root, 'run', 'daemon-lifecycle.lock');
    const old = 'old-token';
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, `claim-${old}.json`),
      `${JSON.stringify({ format: 1, owner: 4242, token: old, verb: 'stop', at: 1, holder: { boot: 'boot-1', namespace: 'pid:[1]', start: '9' } })}\n`,
    );
    const notes: string[] = [];
    const claim = await lock().acquire(request(lockPath, notes));
    expect(notes.some(note => note.startsWith('reclaimed: stop (owner 4242'))).toBe(true);
    const names = await readdir(lockPath);
    expect(names).not.toContain(`claim-${old}.json`);
    expect(names).toHaveLength(1);
    await claim.release();
  });
});

describe('the daemon lock file', () => {
  test('F-0042 the daemon lock is run/daemon.lock in the state home FY_HOME names', async () => {
    const home = await temp();
    const layout = resolveDaemonLayout({
      platform: 'linux',
      homeDirectory: join(home, 'user'),
      stateHome: join(home, 'fy-home'),
      userId: 1000,
      daemonName: 'fyd',
      product: 'ferretry',
      searchPath: '/usr/bin',
    });
    expect(layout.daemonLockFile).toBe(join(home, 'fy-home', 'run', 'daemon.lock'));
  });
});
