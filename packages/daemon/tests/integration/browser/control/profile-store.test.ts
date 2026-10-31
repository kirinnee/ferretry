import { afterEach, describe, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import should from 'should';
import { BrowserProfileStore } from '../../../../src/adapters/index.ts';
import { BrowserControlError, BrowserProfileBusyError } from '../../../../src/lib/index.ts';

const roots: string[] = [];

async function profile(alive: (pid: number) => boolean = () => false): Promise<BrowserProfileStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ferretry-browser-profile-'));
  roots.push(root);
  return new BrowserProfileStore(path.join(root, 'daemon'), {
    daemonPid: 1001,
    hostname: 'test-host',
    isProcessAlive: alive,
    now: () => new Date(0),
  });
}

afterEach(async () => await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe('BrowserProfileStore', () => {
  it('should turn password saving off in the profile on every lease, keeping its other preferences', async () => {
    // Arrange — a profile made before this rule, with its own preferences and saving switched on.
    const subject = await profile();
    const preferences = path.join(subject.browserDirectory, 'profile', 'Default', 'Preferences');
    await mkdir(path.dirname(preferences), { recursive: true });
    await writeFile(
      preferences,
      JSON.stringify({
        credentials_enable_service: true,
        profile: { password_manager_enabled: true, name: 'x' },
        kept: 1,
      }),
    );

    // Act
    const lease = await subject.acquire({ sessionId: 'first' });

    // Assert
    should(JSON.parse(await readFile(preferences, 'utf8'))).eql({
      credentials_enable_service: false,
      credentials_enable_autosignin: false,
      profile: { password_manager_enabled: false, name: 'x' },
      kept: 1,
    });
    await lease.release();
  });

  it('should write a fresh preferences file for a new profile and over one that does not parse', async () => {
    // Arrange
    const fresh = await profile();
    const damaged = await profile();
    const damagedFile = path.join(damaged.browserDirectory, 'profile', 'Default', 'Preferences');
    await mkdir(path.dirname(damagedFile), { recursive: true });
    await writeFile(damagedFile, '{ not json');

    // Act
    await (await fresh.acquire({ sessionId: 'first' })).release();
    await (await damaged.acquire({ sessionId: 'first' })).release();

    // Assert
    for (const file of [path.join(fresh.browserDirectory, 'profile', 'Default', 'Preferences'), damagedFile])
      should(JSON.parse(await readFile(file, 'utf8'))).match({
        credentials_enable_service: false,
        profile: { password_manager_enabled: false },
      });
  });

  it('should refuse the lease, and leave none behind, when password saving cannot be turned off', async () => {
    // Arrange — the preferences file's place is taken by a directory, so it cannot be written.
    const subject = await profile();
    await mkdir(path.join(subject.browserDirectory, 'profile', 'Default', 'Preferences'), { recursive: true });

    // Act
    let refused: unknown;
    try {
      await subject.acquire({ sessionId: 'first' });
    } catch (error) {
      refused = error;
    }

    // Assert
    should(refused).instanceOf(BrowserControlError);
    should((refused as Error).message).containEql('could not turn off password saving');
    await rm(path.join(subject.browserDirectory, 'profile', 'Default', 'Preferences'), { recursive: true });
    await (await subject.acquire({ sessionId: 'again' })).release();
  });

  it('should lease a private profile, record explicit priming, and protect against Chrome downgrades', async () => {
    // Arrange
    const subject = await profile();

    // Act
    const lease = await subject.acquire({ sessionId: 'first', chromeVersion: 'Chrome 150.0.0.0' });
    await lease.updateChromePid(2002, 'Chrome 151.0.0.0');
    await lease.updateChromePid();
    await lease.markPrimed('Chrome 151.0.0.0');

    // Assert
    should(lease.profile).equal(path.join(subject.browserDirectory, 'profile'));
    should(await subject.isPrimed()).be.true();
    await subject.assertChromeVersionCompatible('Chrome 151.0.0.0');
    let downgrade: unknown;
    try {
      await subject.assertChromeVersionCompatible('Chrome 150.0.0.0');
    } catch (error) {
      downgrade = error;
    }
    should(downgrade).instanceOf(BrowserControlError);
    should(JSON.parse(await readFile(subject.leaseFile, 'utf8'))).not.have.property('chromePid');
    should(await lease.release()).be.true();
    should(await lease.release()).be.false();
  });

  it('should still refuse a Chrome downgrade when one recorded version is not a string', async () => {
    // Arrange — a hand-edited metadata file whose created version became a number. The other recorded
    // version still guards the profile, so the damaged field must cost itself alone.
    const subject = await profile();
    const lease = await subject.acquire({ sessionId: 'first' });
    await lease.release();
    await writeFile(
      path.join(subject.browserDirectory, 'profile.metadata.json'),
      JSON.stringify({ createdChromeVersion: 150, latestChromeVersion: 'Chrome 151.0.0.0' }),
    );

    // Act
    let downgrade: unknown;
    try {
      await subject.assertChromeVersionCompatible('Chrome 150.0.0.0');
    } catch (error) {
      downgrade = error;
    }

    // Assert
    should(downgrade).instanceOf(BrowserControlError);
    should((downgrade as BrowserControlError).code).equal('launch_failed');
  });

  it('should refuse a second acquisition by the session that already holds the lease', async () => {
    // A lease is exclusive against EVERYONE, and the owner is not an exception. The launcher keeps a
    // lease it could not prove safe to release, so the session named on that record is the first
    // caller to come back — and handing it straight back would give a quarantined profile to exactly
    // the retry the quarantine exists to stop, with two lease objects then aliasing one record and
    // able to release each other.
    // Arrange — this daemon must read as ALIVE, or a same-session retry would reach the dead-owner
    // reclaim and pass for entirely the wrong reason.
    const subject = await profile(pid => pid === 1001);
    await subject.acquire({ sessionId: 'first' });

    // Act
    let refusal: unknown;
    try {
      await subject.acquire({ sessionId: 'first' });
    } catch (error) {
      refusal = error;
    }

    // Assert — the ordinary live-owner refusal, not a special case: one lease at a time, and only its
    // holder releases it.
    should(refusal).instanceOf(BrowserProfileBusyError);
    should(refusal).have.property('reason', 'lease');
  });

  it('should let the same session acquire again once it has released its lease', async () => {
    // The over-blocking guard. Exclusivity must quarantine a RETAINED lease, never a legitimate
    // restart: a session that closed cleanly has released, and its next launch is ordinary business.
    // Arrange
    const subject = await profile(pid => pid === 1001);
    const held = await subject.acquire({ sessionId: 'first' });

    // Act
    should(await held.release()).be.true();

    // Assert
    should(await subject.acquire({ sessionId: 'first' })).have.property('sessionId', 'first');
  });

  it('should use the production process inspector to retain a lease owned by this daemon', async () => {
    // Arrange
    const root = await mkdtemp(path.join(os.tmpdir(), 'ferretry-browser-profile-production-'));
    roots.push(root);
    const subject = new BrowserProfileStore(path.join(root, 'daemon'));
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await writeFile(
      subject.leaseFile,
      JSON.stringify({ sessionId: 'live', daemonPid: process.pid, acquiredAt: new Date(0).toISOString() }),
    );

    // Act + Assert
    await should(subject.acquire({ sessionId: 'other' })).be.rejectedWith(BrowserProfileBusyError);
  });

  it('should refuse live owners, reclaim dead owners, and never reclaim their live Chrome child', async () => {
    // Arrange
    const subject = await profile(pid => pid === 4444);
    await subject.acquire({ sessionId: 'seed' });
    await writeFile(
      subject.leaseFile,
      JSON.stringify({ sessionId: 'live', daemonPid: 4444, acquiredAt: new Date(0).toISOString() }),
    );

    // Act + Assert
    await should(subject.acquire({ sessionId: 'other' })).be.rejectedWith(BrowserProfileBusyError);
    await writeFile(
      subject.leaseFile,
      JSON.stringify({ sessionId: 'dead', daemonPid: 3333, chromePid: 4444, acquiredAt: new Date(0).toISOString() }),
    );
    await should(subject.acquire({ sessionId: 'other' })).be.rejectedWith(BrowserProfileBusyError);
    await writeFile(
      subject.leaseFile,
      JSON.stringify({ sessionId: 'dead', daemonPid: 3333, acquiredAt: new Date(0).toISOString() }),
    );
    const reclaimed = await subject.acquire({ sessionId: 'other' });
    should(reclaimed.recoveredDeadOwner).be.true();
  });

  it('should clean Chrome lock material only with proof that its owner is dead', async () => {
    // Arrange
    const subject = await profile();
    const first = await subject.acquire({ sessionId: 'first' });
    await writeFile(path.join(first.profile, 'DevToolsActivePort'), 'unproven');

    // Act + Assert
    should(await first.cleanupStaleChromeLocks()).deepEqual([]);
    should(await readFile(path.join(first.profile, 'DevToolsActivePort'), 'utf8')).equal('unproven');
    await first.release();
    await symlink('test-host-9999', path.join(subject.profile, 'SingletonLock'));
    for (const name of ['SingletonSocket', 'SingletonCookie'])
      await writeFile(path.join(subject.profile, name), 'stale');
    const stale = await subject.acquire({ sessionId: 'stale' });
    should(await stale.cleanupStaleChromeLocks()).deepEqual([
      'SingletonLock',
      'SingletonSocket',
      'SingletonCookie',
      'DevToolsActivePort',
    ]);
  });

  it('should release its just-created lease when a live Chrome lock blocks acquisition', async () => {
    // Arrange
    const subject = await profile(pid => pid === 9009);
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await symlink('test-host-9009', path.join(subject.profile, 'SingletonLock'));

    // Act + Assert
    await should(subject.acquire({ sessionId: 'blocked' })).be.rejectedWith(BrowserProfileBusyError);
    await should(readFile(subject.leaseFile, 'utf8')).be.rejected();
  });

  it('should reclaim a lease whose owner process has really exited, using the production inspector', async () => {
    // Arrange: a real child that has been reaped, so its pid is gone and signalling it fails.
    const root = await mkdtemp(path.join(os.tmpdir(), 'ferretry-browser-profile-exited-'));
    roots.push(root);
    const subject = new BrowserProfileStore(path.join(root, 'daemon'));
    const child = spawn(process.execPath, ['--version'], { stdio: 'ignore' });
    const exitedPid = child.pid as number;
    await new Promise(resolve => child.once('exit', resolve));
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await writeFile(
      subject.leaseFile,
      JSON.stringify({ sessionId: 'gone', daemonPid: exitedPid, acquiredAt: new Date(0).toISOString() }),
    );

    // Act
    const lease = await subject.acquire({ sessionId: 'next' });

    // Assert
    should(lease.recoveredDeadOwner).be.true();
  });

  it('should treat a process it may not signal as alive', async () => {
    // Arrange: pid 1 exists on every host; a non-root caller is refused with EPERM, root is allowed.
    const root = await mkdtemp(path.join(os.tmpdir(), 'ferretry-browser-profile-eperm-'));
    roots.push(root);
    const subject = new BrowserProfileStore(path.join(root, 'daemon'));
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await writeFile(
      subject.leaseFile,
      JSON.stringify({ sessionId: 'init', daemonPid: 1, acquiredAt: new Date(0).toISOString() }),
    );

    // Act + Assert
    await should(subject.acquire({ sessionId: 'other' })).be.rejectedWith(BrowserProfileBusyError);
  });

  it('should refuse a blank session id before it touches the profile', async () => {
    // Arrange
    const subject = await profile();

    // Act
    const refusal = await subject.acquire({ sessionId: '   ' }).catch((error: unknown) => error);

    // Assert
    should(refusal).instanceOf(BrowserControlError);
    should((refusal as BrowserControlError).code).equal('bad_request');
    await should(readFile(subject.leaseFile, 'utf8')).be.rejected();
  });

  it('should refuse a Chrome lock it cannot verify, and release its just-created lease', async () => {
    // Arrange
    const subject = await profile();
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await symlink('another-host-1234', path.join(subject.profile, 'SingletonLock'));

    // Act
    const refusal = await subject.acquire({ sessionId: 'blocked' }).catch((error: unknown) => error);

    // Assert
    should(refusal).instanceOf(BrowserProfileBusyError);
    should((refusal as BrowserProfileBusyError).reason).equal('unknown');
    await should(readFile(subject.leaseFile, 'utf8')).be.rejected();
  });

  it('should refuse a Chrome lock that is not a symlink at all', async () => {
    // Arrange
    const subject = await profile();
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await writeFile(path.join(subject.profile, 'SingletonLock'), 'not a symlink');

    // Act
    const refusal = await subject.acquire({ sessionId: 'blocked' }).catch((error: unknown) => error);

    // Assert
    should(refusal).instanceOf(BrowserProfileBusyError);
    should((refusal as BrowserProfileBusyError).message).containEql('not a readable symlink');
  });

  it('should refuse a lease file that cannot be parsed rather than reclaim it', async () => {
    // Arrange
    const subject = await profile();
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await writeFile(subject.leaseFile, '{ torn');

    // Act
    const refusal = await subject.acquire({ sessionId: 'other' }).catch((error: unknown) => error);

    // Assert
    should(refusal).instanceOf(BrowserProfileBusyError);
    should((refusal as BrowserProfileBusyError).message).containEql('malformed');
    should(await readFile(subject.leaseFile, 'utf8')).equal('{ torn');
  });

  it('should refuse chrome pid, version and priming input that is unusable, and say which', async () => {
    // Arrange
    const subject = await profile();
    const lease = await subject.acquire({ sessionId: 'first' });

    // Act
    const badPid = await lease.updateChromePid(-3).catch((error: unknown) => error);
    const badVersion = await lease.updateChromePid(2002, 'not a version').catch((error: unknown) => error);
    const blankPriming = await lease.markPrimed('   ').catch((error: unknown) => error);

    // Assert
    should((badPid as BrowserControlError).code).equal('bad_request');
    should((badVersion as BrowserControlError).code).equal('launch_failed');
    should((blankPriming as BrowserControlError).code).equal('bad_request');
    should(await subject.isPrimed()).be.false();
  });

  it('should refuse every write from a lease that was released, and say it is no longer owned', async () => {
    // Arrange
    const subject = await profile();
    const lease = await subject.acquire({ sessionId: 'first' });
    await lease.release();

    // Act
    const refusal = await lease.updateChromePid(2002).catch((error: unknown) => error);

    // Assert
    should(refusal).instanceOf(BrowserProfileBusyError);
    should((refusal as BrowserProfileBusyError).reason).equal('lease');
  });

  it('should refuse to clean Chrome locks while Chrome is live or its lock cannot be verified', async () => {
    // Arrange
    const subject = await profile(pid => pid === 9009);
    const lease = await subject.acquire({ sessionId: 'first' });
    const lock = path.join(subject.profile, 'SingletonLock');

    // Act
    await symlink('test-host-9009', lock);
    const live = await lease.cleanupStaleChromeLocks().catch((error: unknown) => error);
    await rm(lock);
    await symlink('another-host-9009', lock);
    const unknown = await lease.cleanupStaleChromeLocks().catch((error: unknown) => error);

    // Assert
    should((live as BrowserProfileBusyError).reason).equal('chrome');
    should((unknown as BrowserProfileBusyError).reason).equal('unknown');
  });

  it('should surface a Chrome lock file it cannot remove instead of calling the profile clean', async () => {
    // Arrange: a directory with content cannot be removed as a file.
    const subject = await profile();
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await symlink('test-host-9999', path.join(subject.profile, 'SingletonLock'));
    await mkdir(path.join(subject.profile, 'SingletonSocket'));
    await writeFile(path.join(subject.profile, 'SingletonSocket', 'held'), 'x');
    const lease = await subject.acquire({ sessionId: 'stale' });

    // Act
    const failure = await lease.cleanupStaleChromeLocks().catch((error: unknown) => error);

    // Assert
    should(failure).instanceOf(Error);
    should(failure).not.instanceOf(BrowserProfileBusyError);
  });

  it('should back off while a live reclaimer holds the guard, and clear a guard whose reclaimer is gone', async () => {
    // Arrange
    const root = await mkdtemp(path.join(os.tmpdir(), 'ferretry-browser-profile-guard-'));
    roots.push(root);
    const alive = new Set([2222]);
    const naps: number[] = [];
    const subject = new BrowserProfileStore(path.join(root, 'daemon'), {
      daemonPid: 1001,
      hostname: 'test-host',
      isProcessAlive: pid => alive.has(pid),
      now: () => new Date(0),
      sleep: async milliseconds => {
        naps.push(milliseconds);
        alive.delete(2222);
      },
    });
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    const guardFile = path.join(subject.browserDirectory, 'profile.lock.reclaim');
    await writeFile(
      subject.leaseFile,
      JSON.stringify({ sessionId: 'dead', daemonPid: 3333, acquiredAt: new Date(0).toISOString() }),
    );
    await writeFile(
      guardFile,
      JSON.stringify({ sessionId: 'reclaim-2222', daemonPid: 2222, acquiredAt: new Date(0).toISOString() }),
    );

    // Act
    const lease = await subject.acquire({ sessionId: 'next' });

    // Assert: it napped once for the live reclaimer, then cleared the guard once that reclaimer died.
    should(naps).eql([10]);
    should(lease.recoveredDeadOwner).be.true();
    await should(readFile(guardFile, 'utf8')).be.rejected();
  });

  it('should clear an unreadable reclaim guard and still reclaim the dead lease', async () => {
    // Arrange
    const subject = await profile();
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    await writeFile(
      subject.leaseFile,
      JSON.stringify({ sessionId: 'dead', daemonPid: 3333, acquiredAt: new Date(0).toISOString() }),
    );
    await writeFile(path.join(subject.browserDirectory, 'profile.lock.reclaim'), 'garbage');

    // Act
    const lease = await subject.acquire({ sessionId: 'next' });

    // Assert
    should(lease.recoveredDeadOwner).be.true();
  });

  it('should leave a lease alone when its owner turns out to be alive by the time the guard is held', async () => {
    // Arrange: the owner reads as dead to acquire's own check, then as alive to the guarded re-check.
    const root = await mkdtemp(path.join(os.tmpdir(), 'ferretry-browser-profile-race-'));
    roots.push(root);
    let looks = 0;
    const subject = new BrowserProfileStore(path.join(root, 'daemon'), {
      daemonPid: 1001,
      hostname: 'test-host',
      isProcessAlive: pid => {
        if (pid !== 3333) return false;
        looks += 1;
        return looks > 1;
      },
      now: () => new Date(0),
    });
    const seed = await subject.acquire({ sessionId: 'seed' });
    await seed.release();
    const record = { sessionId: 'racing', daemonPid: 3333, acquiredAt: new Date(0).toISOString() };
    await writeFile(subject.leaseFile, JSON.stringify(record));

    // Act
    const refusal = await subject.acquire({ sessionId: 'next' }).catch((error: unknown) => error);

    // Assert: the record survives, and the caller is told the owner is live.
    should(refusal).instanceOf(BrowserProfileBusyError);
    should(JSON.parse(await readFile(subject.leaseFile, 'utf8'))).containEql({ sessionId: 'racing' });
  });
});
