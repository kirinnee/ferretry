import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { armSessionTurnChanges, StorageSessionStops } from '../../../src/adapters/attention/session-turn-stops.ts';
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
import { TurnChanges } from '../../../src/lib/attention/index.ts';
import { parseSessionId } from '../../../src/lib/index.ts';

/** A ferret's idle period, read from the state document the daemon already keeps. Runs against a temp `FY_HOME`. */

const homes = new Set<string>();
const NOW = '2026-10-23T10:00:00.000Z';
const ID = parseSessionId('session-1');

async function openStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-turn-stops-'));
  homes.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
  await opened.storage.writeConfig(ID, {
    id: 'session-1',
    name: 'Stops',
    agent: '/opt/fleet/bin/claude',
    command: ['/opt/fleet/bin/claude'],
    cwd: '/workspace/project',
    mode: 'auto',
    turn: 1,
    tmuxSession: 'fy-session-1',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return opened.storage;
}

const state = (extra: Record<string, unknown>) => ({ id: 'session-1', status: 'running', turn: 1, ...extra });

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('StorageSessionStops', () => {
  it('should name the idle period by its turnStateAt, for a ferret that handed back or waits on a prompt', async () => {
    // Arrange
    const storage = await openStorage();
    const stops = new StorageSessionStops(storage);

    // Act
    await storage.writeState(ID, state({ turnState: 'your-turn', turnStateAt: '2026-10-23T09:00:00.000Z' }));
    const handedBack = await stops.current('session-1');
    await storage.writeState(ID, state({ turnState: 'needs-input', turnStateAt: '2026-10-23T09:30:00.000Z' }));
    const prompted = await stops.current('session-1');

    // Assert
    should(handedBack).equal('2026-10-23T09:00:00.000Z');
    should(prompted).equal('2026-10-23T09:30:00.000Z');
    await storage.close();
  });

  it('should be absent while the ferret works, when the session keeps no turn state, and for ids it refuses', async () => {
    // Arrange
    const storage = await openStorage();
    const stops = new StorageSessionStops(storage);

    // Act
    await storage.writeState(ID, state({ turnState: 'working', turnStateAt: NOW }));
    const working = await stops.current('session-1');
    await storage.writeState(ID, state({}));
    const none = await stops.current('session-1');

    // Assert
    should(working).be.undefined();
    should(none).be.undefined();
    should(await stops.current('../escape')).be.undefined();
    await storage.close();
  });
});

describe('armSessionTurnChanges', () => {
  const settle = async () => await new Promise(resolve => setTimeout(resolve, 50));

  it('should call back when the turn moves, never for another write, and never for a ferret idle before it started', async () => {
    // Arrange
    const storage = await openStorage();
    await storage.writeState(ID, state({ turnState: 'your-turn', turnStateAt: '2026-10-23T09:00:00.000Z' }));
    const moved: string[] = [];

    // Act
    const stop = armSessionTurnChanges(storage, new TurnChanges(), async id => void moved.push(id));
    await settle();
    await storage.writeState(ID, state({ turnState: 'your-turn', turnStateAt: '2026-10-23T09:00:00.000Z', turn: 2 }));
    await settle();
    const beforeMove = [...moved];
    await storage.writeState(ID, state({ turnState: 'working', turnStateAt: '2026-10-23T09:10:00.000Z' }));
    await settle();
    stop();
    await storage.writeState(ID, state({ turnState: 'your-turn', turnStateAt: '2026-10-23T09:20:00.000Z' }));
    await settle();

    // Assert
    should(beforeMove).deepEqual([]);
    should(moved).deepEqual(['session-1']);
    await storage.close();
  });
});
