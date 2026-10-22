/**
 * The session records a runtime removal or rename reads and re-points, over the daemon's real session
 * storage in a temporary state home.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { RuntimeSessionRecords } from '../../../src/adapters/fleet/runtime-session-records.ts';
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
} from '../../../src/adapters/index.ts';
import { parseSessionId } from '../../../src/lib/index.ts';

const homes: string[] = [];
const stores: DaemonStorage[] = [];

afterEach(async () => {
  for (const storage of stores.splice(0)) await storage.close().catch(() => undefined);
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function storageWith(
  sessions: Readonly<Record<string, { config: unknown; status?: string }>>,
): Promise<DaemonStorage> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-runtime-records-'));
  homes.push(home);
  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date('2026-10-22T09:00:00.000Z')),
    () => new KeyedSerialExecutor(),
  ).open();
  stores.push(opened.storage);
  for (const [id, { config, status }] of Object.entries(sessions)) {
    const sessionId = parseSessionId(id);
    await opened.storage.writeConfig(sessionId, config);
    if (status !== undefined) await opened.storage.writeState(sessionId, { id, status, turn: 1 });
  }
  return opened.storage;
}

const WRAPPER = (name: string): string => `/fy/fleet/bin/${name}`;

describe('RuntimeSessionRecords', () => {
  it('should read every session that says which runtime it runs on, and leave out the rest', async () => {
    // Arrange
    const storage = await storageWith({
      'with-teammate': {
        config: { name: 'one', teammate: 'Fisher', harness: 'claude', agent: 'glm-b', command: [WRAPPER('glm-b')] },
        status: 'running',
      },
      'named-only': { config: { name: 'two', harness: 'codex', agent: 'codex-a' }, status: 'completed' },
      'no-state': { config: { name: 'three', harness: 'claude', agent: 'glm-b' } },
      'no-harness': { config: { name: 'four', agent: 'glm-b' }, status: 'running' },
    });

    // Act
    const records = await new RuntimeSessionRecords(storage).sessionRecords();

    // Assert
    should(records.toSorted((left, right) => left.id.localeCompare(right.id))).deepEqual([
      { id: 'named-only', name: 'two', harness: 'codex', agent: 'codex-a', status: 'completed' },
      {
        id: 'with-teammate',
        name: 'Fisher',
        harness: 'claude',
        agent: 'glm-b',
        executable: WRAPPER('glm-b'),
        status: 'running',
      },
    ]);
  });

  it('should re-point every record on the old runtime, ended ones included, and touch no other', async () => {
    // Arrange
    const storage = await storageWith({
      running: {
        config: { name: 'a', harness: 'claude', agent: 'glm-b', command: [WRAPPER('glm-b'), '--resume', 'x'] },
        status: 'running',
      },
      ended: {
        config: { name: 'b', harness: 'claude', agent: 'glm-b', command: [WRAPPER('glm-b')] },
        status: 'stopped',
      },
      other: {
        config: { name: 'c', harness: 'claude', agent: 'other', command: [WRAPPER('other')] },
        status: 'running',
      },
    });

    // Act
    const moved = await new RuntimeSessionRecords(storage).renameSessions({
      from: 'glm-b',
      to: 'glm-work',
      fromWrapper: WRAPPER('glm-b'),
      toWrapper: WRAPPER('glm-work'),
    });

    // Assert
    should(moved).equal(2);
    should(await storage.readConfig(parseSessionId('running'))).match({
      agent: 'glm-work',
      command: [WRAPPER('glm-work'), '--resume', 'x'],
    });
    should(await storage.readConfig(parseSessionId('ended'))).match({
      agent: 'glm-work',
      command: [WRAPPER('glm-work')],
    });
    should(await storage.readConfig(parseSessionId('other'))).match({ agent: 'other', command: [WRAPPER('other')] });
  });

  it('should keep going past a record it cannot read, and say how many it moved', async () => {
    // Arrange
    const storage = await storageWith({
      kept: { config: { name: 'a', harness: 'claude', agent: 'glm-b' }, status: 'running' },
    });
    const failing = {
      listSessions: () => [{ id: parseSessionId('broken') }, ...storage.listSessions()],
      readConfig: async (id: Parameters<DaemonStorage['readConfig']>[0]) => {
        if (id === 'broken') throw new Error('the config is torn');
        return await storage.readConfig(id);
      },
      readState: async (id: Parameters<DaemonStorage['readState']>[0]) => await storage.readState(id),
      updateConfig: storage.updateConfig.bind(storage),
    } as unknown as DaemonStorage;

    // Act
    const records = new RuntimeSessionRecords(failing);
    const moved = await records.renameSessions({
      from: 'glm-b',
      to: 'glm-work',
      fromWrapper: WRAPPER('glm-b'),
      toWrapper: WRAPPER('glm-work'),
    });

    // Assert
    should(moved).equal(1);
    should((await records.sessionRecords()).map(record => record.id)).deepEqual(['kept']);
  });
});
