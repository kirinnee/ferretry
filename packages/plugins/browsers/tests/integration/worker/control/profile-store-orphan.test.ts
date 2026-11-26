import { afterEach, describe, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import should from 'should';
import { BrowserProfileStore } from '../../../../daemon/worker/control/adapters/profile-store.ts';
import { BrowserProfileBusyError } from '../../../../daemon/worker/control/profile.ts';

const roots: string[] = [];
const children: ChildProcess[] = [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A synthetic "Chrome": an idle process whose command line carries the given extra arguments. */
function idleProcess(...args: string[]): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...args], { stdio: 'ignore' });
  children.push(child);
  return child.pid as number;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['--version'], { stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  return child.pid as number;
}

async function store(): Promise<BrowserProfileStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ferretry-browser-orphan-'));
  roots.push(root);
  return new BrowserProfileStore(path.join(root, 'daemon'), { hostname: 'test-host' });
}

/** The profile as a dead daemon left it: a lease naming it and a Chrome pid. */
async function leftBehind(subject: BrowserProfileStore, chromePid: number): Promise<void> {
  const seed = await subject.acquire({ sessionId: 'seed' });
  await seed.release();
  await writeFile(
    subject.leaseFile,
    JSON.stringify({
      sessionId: 'dead',
      daemonPid: await exitedPid(),
      chromePid,
      acquiredAt: new Date(0).toISOString(),
    }),
  );
}

async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!alive(pid)) return true;
    await Bun.sleep(20);
  }
  return false;
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('BrowserProfileStore orphaned Chrome', () => {
  it('should stop a Chrome a dead daemon left on the profile and hand the profile out', async () => {
    // Arrange
    const subject = await store();
    const orphan = idleProcess(`--user-data-dir=${subject.profile}`);
    await leftBehind(subject, orphan);

    // Act
    const lease = await subject.acquire({ sessionId: 'next' });

    // Assert
    should(lease.recoveredDeadOwner).be.true();
    should(await gone(orphan)).be.true();
  });

  it('should stop a Chrome that still holds the profile lock though no lease names it', async () => {
    // Arrange
    const subject = await store();
    const orphan = idleProcess(`--user-data-dir=${subject.profile}`);
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await symlink(`test-host-${orphan}`, path.join(subject.profile, 'SingletonLock'));

    // Act
    const lease = await subject.acquire({ sessionId: 'next' });

    // Assert
    should(await gone(orphan)).be.true();
    should(lease.sessionId).equal('next');
  });

  it('should never signal a process that is not on this profile, and still reclaim the lease from a recycled pid', async () => {
    // Arrange: a live process (say the owner's own browser) that the dead lease's pid has been recycled into.
    const subject = await store();
    const stranger = idleProcess(`--user-data-dir=${path.join(os.tmpdir(), 'someone-elses-profile')}`);
    await leftBehind(subject, stranger);

    // Act
    const lease = await subject.acquire({ sessionId: 'next' });

    // Assert
    should(lease.recoveredDeadOwner).be.true();
    should(alive(stranger)).be.true();
  });

  it('should refuse, and not signal, a live lock holder that is not on this profile', async () => {
    // Arrange
    const subject = await store();
    const stranger = idleProcess(`--user-data-dir=${path.join(os.tmpdir(), 'someone-elses-profile')}`);
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await symlink(`test-host-${stranger}`, path.join(subject.profile, 'SingletonLock'));

    // Act + Assert
    await should(subject.acquire({ sessionId: 'next' })).be.rejectedWith(BrowserProfileBusyError);
    should(alive(stranger)).be.true();
    await should(readFile(subject.leaseFile, 'utf8')).be.rejected();
  });

  it('should refuse a lease whose live owner daemon is still running, never touching its Chrome', async () => {
    // Arrange: this very test process stands in for the live daemon; its Chrome is on the profile.
    const subject = await store();
    const chrome = idleProcess(`--user-data-dir=${subject.profile}`);
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await writeFile(
      subject.leaseFile,
      JSON.stringify({
        sessionId: 'live',
        daemonPid: process.pid,
        chromePid: chrome,
        acquiredAt: new Date(0).toISOString(),
      }),
    );

    // Act + Assert
    await should(subject.acquire({ sessionId: 'other' })).be.rejectedWith(BrowserProfileBusyError);
    should(alive(chrome)).be.true();
  });

  it('should refuse and not signal a Chrome whose command line cannot be read', async () => {
    // Arrange
    const orphan = idleProcess('--anything');
    const root = await mkdtemp(path.join(os.tmpdir(), 'ferretry-browser-orphan-'));
    roots.push(root);
    const terminated: number[] = [];
    const subject = new BrowserProfileStore(path.join(root, 'daemon'), {
      hostname: 'test-host',
      orphans: {
        readArguments: async () => undefined,
        terminate: async pid => {
          terminated.push(pid);
          return true;
        },
      },
    });
    await leftBehind(subject, orphan);

    // Act + Assert
    await should(subject.acquire({ sessionId: 'next' })).be.rejectedWith(BrowserProfileBusyError);
    should(terminated).deepEqual([]);
    should(alive(orphan)).be.true();
  });
});
