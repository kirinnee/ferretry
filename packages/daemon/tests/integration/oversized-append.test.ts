import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorage,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../src/adapters/index.ts';
import {
  createSessionPaths,
  JournalRecordTooLargeError,
  MAX_JOURNAL_RECORD_BYTES,
  parseSessionId,
} from '../../src/lib/index.ts';

const homes = new Set<string>();
const stores = new Set<DaemonStorage>();

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
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
  for (const storage of stores) await storage.close().catch(() => undefined);
  stores.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('oversized append validation', () => {
  it('should reject the final encoded event before creating a session or index row', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-oversized-append-test-'));
    homes.add(home);
    const factory = new DaemonStorageFactory(
      new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
      new StateFileSystemFactory(),
      new StateHomeLayout(),
      new SqliteHomeLockFactory(),
      new BunSqliteIndexFactory(),
      new SystemClock(() => new Date('2026-07-30T12:00:00.000Z')),
      () => new KeyedSerialExecutor(),
    );
    const opened = await factory.open();
    stores.add(opened.storage);
    const id = parseSessionId('oversized-event');

    // Act
    const error = await capturedError(
      async () => await opened.storage.append(id, 'too-large', { blob: 'x'.repeat(MAX_JOURNAL_RECORD_BYTES + 1) }),
    );

    // Assert
    should(error).be.instanceOf(JournalRecordTooLargeError);
    should(await exists(createSessionPaths(opened.paths, id).directory)).be.false();
    should(opened.storage.findSession(id)).be.undefined();
    should(opened.storage.listSessions()).deepEqual([]);
  });
});
