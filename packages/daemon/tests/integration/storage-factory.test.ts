import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../src/adapters/index.ts';
import {
  type FileSystemFactory,
  type FileSystemPort,
  type FoundationPaths,
  parseSessionId,
} from '../../src/lib/index.ts';

/** Opening a state home, against real files: a failed open must not leave the home locked. */

const homes = new Set<string>();

/** Fails the permission repair that every open runs over each session directory it finds. */
class PermissionRepairFailingStateFileSystem extends StateFileSystem {
  override async setMode(path: string, mode: number): Promise<void> {
    if (path.includes('/sessions/')) throw new Error(`injected permission failure at ${path}`);
    await super.setMode(path, mode);
  }
}

class PermissionRepairFailingFactory implements FileSystemFactory {
  create(paths: FoundationPaths): FileSystemPort {
    return new PermissionRepairFailingStateFileSystem(paths);
  }
}

async function createTemporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-storage-factory-'));
  homes.add(home);
  return home;
}

function factoryFor(home: string, fileSystems: FileSystemFactory): DaemonStorageFactory {
  return new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    fileSystems,
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date('2026-07-30T12:00:00.000Z')),
    () => new KeyedSerialExecutor(),
  );
}

async function capturedError(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return error;
  }
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('DaemonStorageFactory', () => {
  it('should release the home lock when the post-open session repair fails, so the next open succeeds', async () => {
    // Arrange: a home that already holds a session directory for the repair to walk.
    const home = await createTemporaryHome();
    const first = await factoryFor(home, new StateFileSystemFactory()).open();
    await first.storage.writeConfig(parseSessionId('20260806-repair'), { id: '20260806-repair' });
    await first.storage.close();

    // Act
    const failed = await capturedError(async () => await factoryFor(home, new PermissionRepairFailingFactory()).open());
    const reopened = await factoryFor(home, new StateFileSystemFactory()).open();
    await reopened.storage.close();

    // Assert: the repair's own failure is what surfaces, and it did not strand the lifetime lock.
    should(failed).be.instanceOf(Error);
    should((failed as Error).message).match(/injected permission failure at .*\/sessions\//u);
  });
});
