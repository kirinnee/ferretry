/**
 * THE TURN WATCHER STOPS READING A SESSION THAT HAS ENDED AND HAS NOTHING LEFT TO SETTLE.
 *
 * It ticks every two seconds and read every session's state on every tick — 36 reads a tick on a Mac
 * where 31 had ended. An ended session can still carry the turn state it stopped with, which only the
 * watcher clears, so it is read until that is done, then not again until the index says it is live.
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
  StorageTurnPorts,
  SystemClock,
} from '../../../../src/adapters/index.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/index.ts';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function storageWithReadCount(): Promise<{ storage: DaemonStorage; reads: SessionId[] }> {
  const home = await mkdtemp(join(tmpdir(), 'fy-turn-settled-'));
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
  const reads: SessionId[] = [];
  const readState = opened.storage.readState.bind(opened.storage);
  opened.storage.readState = async id => {
    reads.push(id);
    return await readState(id);
  };
  return { storage: opened.storage, reads };
}

const ID = parseSessionId('settled-1');

describe('StorageTurnPorts.sessions', () => {
  it('should read an ended session until its turn is settled, then leave it until it is live again', async () => {
    // Arrange — it stopped mid-turn, still recording the turn state it had.
    const { storage, reads } = await storageWithReadCount();
    await storage.writeState(ID, { id: 'settled-1', status: 'stopped', turn: 1, turnState: 'working' });
    const ports = new StorageTurnPorts(
      storage,
      { tail: async () => ({ kind: 'unresolved' }) },
      async () => undefined,
      { activity: async () => undefined, visible: async () => undefined },
      { now: () => '2026-10-21T00:00:00.000Z' },
    );

    // Act
    const unsettled = await ports.sessions();
    await ports.sessions();
    const whileUnsettled = reads.length;
    await storage.writeState(ID, { id: 'settled-1', status: 'stopped', turn: 1 });
    await ports.sessions();
    const settledAfter = reads.length;
    const skipped = await ports.sessions();
    await ports.sessions();
    const whileSettled = reads.length;
    await storage.writeState(ID, { id: 'settled-1', status: 'running', turn: 2 });
    const revived = await ports.sessions();

    // Assert
    should(unsettled.map(session => session.id)).deepEqual([ID]);
    should(whileUnsettled).equal(2);
    should(settledAfter).equal(3);
    should(skipped).deepEqual([]);
    should(whileSettled).equal(3);
    should(revived.map(session => session.state.status)).deepEqual(['running']);
    should(reads.length).equal(4);
  });
});

describe('StorageTurnPorts.paneState', () => {
  it('should find no pane for a session whose configuration is not a document, and capture nothing', async () => {
    // Arrange — the pane's name lives in the lifecycle half of the configuration; a damaged one names none.
    const { storage } = await storageWithReadCount();
    await storage.writeConfig(ID, ['not', 'a', 'configuration']);
    const ports = new StorageTurnPorts(
      storage,
      { tail: async () => ({ kind: 'unresolved' }) },
      async () => undefined,
      {
        activity: async () => Promise.reject(new Error('no pane may be asked about')),
        visible: async () => Promise.reject(new Error('no pane may be captured')),
      },
      { now: () => '2026-10-21T00:00:00.000Z' },
    );

    // Act
    const pane = await ports.paneState(ID);

    // Assert
    should(pane).be.undefined();
  });
});
