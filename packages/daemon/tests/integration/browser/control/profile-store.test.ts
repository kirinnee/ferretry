import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import should from 'should';
import { BrowserControlError, BrowserProfileBusyError } from '../../../../src/lib/index.ts';
import { BrowserProfileStore } from '../../../../src/adapters/index.ts';

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
  it('should lease a private profile, record explicit priming, and protect against Chrome downgrades', async () => {
    // Arrange
    const subject = await profile();

    // Act
    const lease = await subject.acquire({ sessionId: 'first', chromeVersion: 'Chrome 150.0.0.0' });
    await lease.updateChromePid(2002, 'Chrome 151.0.0.0');
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
    should(JSON.parse(await readFile(subject.leaseFile, 'utf8'))).match({ chromePid: 2002 });
    should(await lease.release()).be.true();
    should(await lease.release()).be.false();
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
});
