import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StorageAgentSessions } from '../../../src/adapters/agenda/storage-agent-sessions.ts';
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
import { parseSessionId } from '../../../src/lib/index.ts';

/** Which sessions count as agent ferrets, read from each session's own configuration document on a real storage. */

const homes = new Set<string>();
const storages = new Set<{ close(): Promise<void> | void }>();
const NOW = '2026-10-29T10:00:00.000Z';

const config = (id: string, mode: 'auto' | 'interactive') => ({
  id,
  name: id,
  agent: '/opt/fleet/bin/claude',
  harness: 'claude',
  command: ['/opt/fleet/bin/claude'],
  cwd: '/workspace/project',
  mode,
  turn: 1,
  tmuxSession: `fy-${id}`,
  createdAt: NOW,
  updatedAt: NOW,
});

async function open() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-agent-sessions-'));
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
  const { storage } = await factory.open();
  storages.add(storage);
  return storage;
}

afterEach(async () => {
  for (const storage of storages) await storage.close();
  storages.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('StorageAgentSessions', () => {
  it('should list only the sessions whose own configuration says auto', async () => {
    // Arrange
    const storage = await open();
    await storage.writeConfig(parseSessionId('lead-1'), config('lead-1', 'interactive'));
    await storage.writeConfig(parseSessionId('worker-1'), config('worker-1', 'auto'));
    await storage.writeConfig(parseSessionId('worker-2'), config('worker-2', 'auto'));

    // Act
    const agents = await new StorageAgentSessions(storage).agentSessionIds();

    // Assert
    should([...agents].sort()).deepEqual(['worker-1', 'worker-2']);
  });

  it('should list nothing on a machine with no sessions', async () => {
    // Arrange
    const storage = await open();

    // Act + Assert
    should(await new StorageAgentSessions(storage).agentSessionIds()).deepEqual([]);
  });
});
