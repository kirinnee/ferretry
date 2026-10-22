/**
 * THE `facts` HOOK: storage tells its listeners every state document it writes, as written.
 *
 * Storage is the one writer of `state.json`, so this is how the session observer learns a session's
 * turn fields without re-reading the document every tick (`docs/design/session-workers.md` §2.2).
 * Every write path is covered, a listener can never make a write fail, and config writes say nothing.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../src/adapters/index.ts';
import { parseSessionId } from '../../src/lib/index.ts';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function openStorage(): Promise<DaemonStorage> {
  const home = await mkdtemp(join(tmpdir(), 'fy-state-listeners-'));
  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(),
    () => new KeyedSerialExecutor(),
  ).open();
  cleanups.push(async () => {
    await opened.storage.close();
    await rm(home, { recursive: true, force: true });
  });
  return opened.storage;
}

const ID = parseSessionId('listened-1');

describe('DaemonStorage.subscribeStates', () => {
  it('should tell every state write, in commit order, with the document as written', async () => {
    // Arrange
    const storage = await openStorage();
    const told: unknown[] = [];
    storage.subscribeStates((id, state) => told.push([id, state]));

    // Act
    await storage.writeState(ID, { id: ID, status: 'running', turn: 1 });
    await storage.updateState(ID, raw => ({ ...(raw as Record<string, unknown>), turnState: 'working' }));
    await storage.upsertState(ID, raw => ({ ...(raw as Record<string, unknown>), status: 'stopped' }));
    await storage.writeConfig(ID, { id: ID, name: 'Not a state' });
    await storage.updateConfig(ID, raw => ({ ...(raw as Record<string, unknown>), name: 'Still not' }));

    // Assert
    should(told).deepEqual([
      [ID, { id: ID, status: 'running', turn: 1 }],
      [ID, { id: ID, status: 'running', turn: 1, turnState: 'working' }],
      [ID, { id: ID, status: 'stopped', turn: 1, turnState: 'working' }],
    ]);
  });

  it('should never let a listener fail a write, nor tell one that unsubscribed', async () => {
    // Arrange
    const storage = await openStorage();
    const told: unknown[] = [];
    storage.subscribeStates(() => {
      throw new Error('a broken observer');
    });
    const unsubscribe = storage.subscribeStates((_id, state) => told.push(state));

    // Act
    await storage.writeState(ID, { id: ID, status: 'running', turn: 1 });
    unsubscribe();
    await storage.writeState(ID, { id: ID, status: 'stopped', turn: 1 });

    // Assert
    should(told).deepEqual([{ id: ID, status: 'running', turn: 1 }]);
    should(await storage.readState(ID)).deepEqual({ id: ID, status: 'stopped', turn: 1 });
  });
});
