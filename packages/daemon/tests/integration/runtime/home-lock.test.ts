import { Database } from 'bun:sqlite';
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { SqliteHomeLockFactory, StateFileSystem, StateHomeLockedError } from '../../../src/adapters/index.ts';
import { createFoundationPaths, type FoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

/**
 * The state-home lock, against a real SQLite file.
 *
 * The lock is an OS-backed exclusive transaction, so the only honest way to prove how an acquisition
 * FAILS is to fail it: a second owner for the refusal that names the lock file, and a filesystem that
 * breaks after the lock is taken for the failure that is not a lock at all.
 */

const homes = new Set<string>();
const originalClose = Database.prototype.close;

/** Takes the lock, then fails the way a read-only or vanished file would when its mode is narrowed. */
class ModeFailingFileSystem extends StateFileSystem {
  override async setMode(): Promise<void> {
    throw new Error('injected mode failure');
  }
}

async function pathsInTemporaryHome(): Promise<FoundationPaths> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-home-lock-test-'));
  homes.add(home);
  return createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
}

async function capturedError(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('SqliteHomeLockFactory', () => {
  afterEach(async () => {
    Database.prototype.close = originalClose;
    for (const home of homes) await rm(home, { recursive: true, force: true });
    homes.clear();
  });

  it('should refuse a second owner with the lock file it collided on, and admit one once the first lets go', async () => {
    // Arrange
    const paths = await pathsInTemporaryHome();
    const fileSystem = new StateFileSystem(paths);
    const factory = new SqliteHomeLockFactory();
    const first = await factory.acquire(paths, fileSystem);

    // Act
    const refused = await capturedError(() => factory.acquire(paths, fileSystem));
    await first.release();
    const second = await factory.acquire(paths, fileSystem);
    await second.release();

    // Assert
    should(refused).be.instanceOf(StateHomeLockedError);
    should((refused as StateHomeLockedError).lockFile).equal(paths.daemonLock);
  });

  it('should rethrow a failure that is not a lock, and leave the lock free for the next owner', async () => {
    // Arrange
    const paths = await pathsInTemporaryHome();
    const factory = new SqliteHomeLockFactory();

    // Act
    const failed = await capturedError(() => factory.acquire(paths, new ModeFailingFileSystem(paths)));
    const next = await factory.acquire(paths, new StateFileSystem(paths));
    await next.release();

    // Assert: the original failure surfaces as itself, not as a claim that another daemon owns the home.
    should(failed).be.instanceOf(Error);
    should(failed).not.be.instanceOf(StateHomeLockedError);
    should((failed as Error).message).equal('injected mode failure');
  });

  it('should surface the acquisition failure even when the database cannot be closed afterwards', async () => {
    // Arrange: the half-open database refuses to close once, as a handle in a bad state would.
    const paths = await pathsInTemporaryHome();
    const factory = new SqliteHomeLockFactory();
    let refusals = 0;
    Database.prototype.close = function close(this: Database, ...rest: [boolean?]) {
      refusals += 1;
      originalClose.apply(this, rest);
      throw new Error('injected close failure');
    };

    // Act
    const failed = await capturedError(() => factory.acquire(paths, new ModeFailingFileSystem(paths)));

    // Assert: the close failure is swallowed so the real cause is the one reported.
    should(refusals).equal(1);
    should((failed as Error).message).equal('injected mode failure');
  });
});
