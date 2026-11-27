import { afterEach, describe, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import should from 'should';
import type {
  OrphanChromeInspector,
  ProcessIdentity,
} from '../../../../daemon/worker/control/adapters/orphan-chrome.ts';
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

/**
 * A synthetic "Chrome": an idle process whose command line carries the given extra arguments. It ends when its stdin
 * closes (cleanup), so no test ever signals a real process.
 */
function idleProcess(...args: string[]): number {
  const child = spawn(
    process.execPath,
    ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))", ...args],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  children.push(child);
  return child.pid as number;
}

/** A simulated process table over one pid: reads answer from `identity`, signals are logged and never sent. */
function simulatedTable(identity: () => ProcessIdentity | undefined, onSignal?: (signal: string) => void) {
  const signals: string[] = [];
  const orphans: OrphanChromeInspector = {
    identify: identity,
    signalIf: (_pid, signal, accept) => {
      const found = identity();
      if (found === undefined) return 'gone';
      if (!accept(found)) return 'rejected';
      signals.push(signal);
      onSignal?.(signal);
      return 'delivered';
    },
    sleep: async () => undefined,
  };
  return { orphans, signals };
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['--version'], { stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  return child.pid as number;
}

async function store(orphans?: OrphanChromeInspector): Promise<BrowserProfileStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ferretry-browser-orphan-'));
  roots.push(root);
  return new BrowserProfileStore(path.join(root, 'daemon'), {
    hostname: 'test-host',
    ...(orphans === undefined ? {} : { orphans }),
  });
}

/** The profile as a dead daemon left it: a lease naming it and a Chrome pid. */
async function leftBehind(subject: BrowserProfileStore, chromePid: number): Promise<void> {
  const seed = await subject.acquire('agent', { sessionId: 'seed' });
  await seed.release();
  await writeFile(
    subject.paths('agent').leaseFile,
    JSON.stringify({
      sessionId: 'dead',
      daemonPid: await exitedPid(),
      chromePid,
      acquiredAt: new Date(0).toISOString(),
    }),
  );
}

/**
 * The profile as a dead daemon left it after FERRETRY launched `chromePid`: the lease carries the launch record the
 * store stamped when the live daemon reported that pid, then its daemon died.
 */
async function leftBehindByFerretry(subject: BrowserProfileStore, chromePid: number): Promise<void> {
  const seed = await subject.acquire('agent', { sessionId: 'seed' });
  await seed.updateChromePid(chromePid);
  const record = JSON.parse(await readFile(subject.paths('agent').leaseFile, 'utf8')) as Record<string, unknown>;
  await writeFile(
    subject.paths('agent').leaseFile,
    JSON.stringify({ ...record, sessionId: 'dead', daemonPid: await exitedPid() }),
  );
}

afterEach(async () => {
  for (const child of children.splice(0)) child.stdin?.end();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('BrowserProfileStore orphaned Chrome', () => {
  it('should stop a Chrome a dead daemon left on the profile and hand the profile out', async () => {
    // Arrange: a simulated table, so nothing real is signalled; the Chrome exits after TERM.
    let running = true;
    const profileHolder: { profile?: string } = {};
    const table = simulatedTable(
      () =>
        running && profileHolder.profile !== undefined
          ? { startedAt: 'boot:100', args: ['chrome', `--user-data-dir=${profileHolder.profile}`] }
          : undefined,
      () => {
        running = false;
      },
    );
    const subject = await store(table.orphans);
    profileHolder.profile = subject.paths('agent').profile;
    const orphan = idleProcess('--anything');
    await leftBehindByFerretry(subject, orphan);

    // Act
    const lease = await subject.acquire('agent', { sessionId: 'next' });

    // Assert
    should(lease.recoveredDeadOwner).be.true();
    should(table.signals).deepEqual(['SIGTERM']);
    should(alive(orphan)).be.true();
  });

  it('should record the start time of the process seen at the spawn, before any awaited file work', async () => {
    // Arrange: the pid answers as the launched Chrome on the first read and as a replacement on every later one.
    let reads = 0;
    const table = simulatedTable(() => {
      reads += 1;
      return { startedAt: reads === 1 ? 'boot:launched' : 'boot:replacement', args: ['chrome'] };
    });
    const subject = await store(table.orphans);
    const seed = await subject.acquire('agent', { sessionId: 'seed' });

    // Act: the caller reports the pid right after its spawn; the identity must be read in that same step.
    const reported = seed.updateChromePid(4242);
    const readsAtCall = reads;
    await reported;

    // Assert
    should(readsAtCall).equal(1);
    const record = JSON.parse(await readFile(subject.paths('agent').leaseFile, 'utf8')) as { chromeStartedAt?: string };
    should(record.chromeStartedAt).equal('boot:launched');
  });

  it('should NEVER signal the owner own Chrome on the profile when the lease holds no Ferretry launch record', async () => {
    // Arrange: a dead daemon's lease names a pid, but no start time was ever stamped: nothing proves it is Ferretry's.
    const subject = await store();
    const owners = idleProcess(`--user-data-dir=${subject.paths('agent').profile}`);
    await leftBehind(subject, owners);

    // Act + Assert
    await should(subject.acquire('agent', { sessionId: 'next' })).be.rejectedWith(BrowserProfileBusyError);
    should(alive(owners)).be.true();
  });

  it('should NEVER signal a Chrome whose start time differs from the one Ferretry recorded', async () => {
    // Arrange: the recorded pid is now the owner's browser, started after the one Ferretry launched.
    const subject = await store();
    const owners = idleProcess(`--user-data-dir=${subject.paths('agent').profile}`);
    await leftBehindByFerretry(subject, owners);
    const record = JSON.parse(await readFile(subject.paths('agent').leaseFile, 'utf8')) as Record<string, unknown>;
    await writeFile(
      subject.paths('agent').leaseFile,
      JSON.stringify({ ...record, chromeStartedAt: 'an-earlier-boot:1' }),
    );

    // Act
    const lease = await subject.acquire('agent', { sessionId: 'next' });

    // Assert: the stale record is cleared as a recycled pid, and nothing was signalled.
    should(lease.recoveredDeadOwner).be.true();
    should(alive(owners)).be.true();
  });

  it('should NEVER signal a Chrome that holds the profile lock when no lease names it', async () => {
    // Arrange: with no Ferretry record at all this is indistinguishable from the owner's own browser.
    const subject = await store();
    const owners = idleProcess(`--user-data-dir=${subject.paths('agent').profile}`);
    const seed = await subject.acquire('agent', { sessionId: 'seed' });
    await seed.release();
    await symlink(`test-host-${owners}`, path.join(subject.paths('agent').profile, 'SingletonLock'));

    // Act + Assert
    await should(subject.acquire('agent', { sessionId: 'next' })).be.rejectedWith(BrowserProfileBusyError);
    should(alive(owners)).be.true();
  });

  it('should never signal a process that is not on this profile, and still reclaim the lease from a recycled pid', async () => {
    // Arrange: a live process (say the owner's own browser) that the dead lease's pid has been recycled into.
    const subject = await store();
    const stranger = idleProcess(`--user-data-dir=${path.join(os.tmpdir(), 'someone-elses-profile')}`);
    await leftBehind(subject, stranger);

    // Act
    const lease = await subject.acquire('agent', { sessionId: 'next' });

    // Assert
    should(lease.recoveredDeadOwner).be.true();
    should(alive(stranger)).be.true();
  });

  it('should refuse, and not signal, a live lock holder that is not on this profile', async () => {
    // Arrange
    const subject = await store();
    const stranger = idleProcess(`--user-data-dir=${path.join(os.tmpdir(), 'someone-elses-profile')}`);
    const seed = await subject.acquire('agent', { sessionId: 'seed' });
    await seed.release();
    await symlink(`test-host-${stranger}`, path.join(subject.paths('agent').profile, 'SingletonLock'));

    // Act + Assert
    await should(subject.acquire('agent', { sessionId: 'next' })).be.rejectedWith(BrowserProfileBusyError);
    should(alive(stranger)).be.true();
    await should(readFile(subject.paths('agent').leaseFile, 'utf8')).be.rejected();
  });

  it('should refuse a lease whose live owner daemon is still running, never touching its Chrome', async () => {
    // Arrange: this very test process stands in for the live daemon; its Chrome is on the profile.
    const subject = await store();
    const chrome = idleProcess(`--user-data-dir=${subject.paths('agent').profile}`);
    const seed = await subject.acquire('agent', { sessionId: 'seed' });
    await seed.release();
    await writeFile(
      subject.paths('agent').leaseFile,
      JSON.stringify({
        sessionId: 'live',
        daemonPid: process.pid,
        chromePid: chrome,
        acquiredAt: new Date(0).toISOString(),
      }),
    );

    // Act + Assert
    await should(subject.acquire('agent', { sessionId: 'other' })).be.rejectedWith(BrowserProfileBusyError);
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
        identify: () => undefined,
        signalIf: pid => {
          terminated.push(pid);
          return 'delivered';
        },
        sleep: async () => undefined,
      },
    });
    await leftBehindByFerretry(subject, orphan);

    // Act + Assert
    await should(subject.acquire('agent', { sessionId: 'next' })).be.rejectedWith(BrowserProfileBusyError);
    should(terminated).deepEqual([]);
    should(alive(orphan)).be.true();
  });
});
