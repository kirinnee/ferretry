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
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../src/adapters/index.ts';
import { mostRecentLiveSession } from '../../../src/adapters/session/owner-session.ts';
import type { DaemonStorage } from '../../../src/adapters/storage/session-storage.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';

/**
 * The session an owner's own card goes on, over REAL session documents in a temporary state home: the answer is read
 * back through storage, so the listing and the state round trip both have to hold.
 */

const NOW = '2026-11-02T09:00:00.000Z';
const ENDED = new Set(['completed', 'failed', 'stopped']);
const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function openTemporaryStorage(): Promise<DaemonStorage> {
  const home = await mkdtemp(join(tmpdir(), 'fy-owner-session-'));
  directories.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  return (await factory.open()).storage;
}

async function seed(storage: DaemonStorage, name: string, state: Record<string, unknown>): Promise<string> {
  const id = parseSessionId(name);
  await storage.writeConfig(id, {
    id,
    name: 'interactive',
    nameSource: 'auto',
    agent: 'claude',
    harness: 'claude',
    mode: 'interactive',
    cwd: '/work/repo',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await storage.writeState(id, state);
  return id;
}

describe('mostRecentLiveSession over real storage', () => {
  it('should pick the live session with the latest activity and skip an ended one', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    await seed(storage, '20261102-older', { status: 'running', lastActivityAt: '2026-11-01T10:00:00.000Z' });
    const newest = await seed(storage, '20261102-newest', {
      status: 'idle',
      lastActivityAt: '2026-11-02T08:30:00.000Z',
    });
    await seed(storage, '20261102-done', { status: 'completed', lastActivityAt: '2026-11-02T08:59:00.000Z' });

    // Act
    const actual = await mostRecentLiveSession(storage, ENDED);

    // Assert
    should(actual).equal(newest);
  });

  it('should fall back to the start time and then say nothing when every session has ended', async () => {
    // Arrange
    const storage = await openTemporaryStorage();
    const started = await seed(storage, '20261102-started', {
      status: 'running',
      startedAt: '2026-11-02T08:00:00.000Z',
    });

    // Act
    const live = await mostRecentLiveSession(storage, ENDED);
    await storage.writeState(parseSessionId(started), { status: 'stopped', startedAt: '2026-11-02T08:00:00.000Z' });
    const none = await mostRecentLiveSession(storage, ENDED);

    // Assert
    should(live).equal(started);
    should(none).be.undefined();
  });
});
