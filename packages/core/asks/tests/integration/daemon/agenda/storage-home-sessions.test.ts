import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StorageHomeSessions } from '../../../../daemon/adapters/agenda/storage-home-sessions.ts';
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

const config = (id: string, mode: 'auto' | 'interactive', extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});

async function open() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-home-sessions-'));
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

describe('StorageHomeSessions', () => {
  it('should read lineage, origin, mode, project and recency from the configuration document', async () => {
    // Arrange
    const storage = await open();
    await storage.writeConfig(
      parseSessionId('kid-1'),
      config('kid-1', 'auto', { parent: 'lead-1', projectId: 'P1', provenance: { v: 1, at: NOW, origin: 'warden' } }),
    );
    await storage.writeConfig(parseSessionId('lead-1'), config('lead-1', 'interactive'));
    const sessions = new StorageHomeSessions(storage);

    // Act
    const kid = await sessions.get('kid-1');
    const lead = await sessions.get('lead-1');

    // Assert
    should(kid).eql({
      id: 'kid-1',
      parent: 'lead-1',
      origin: 'warden',
      mode: 'auto',
      projectId: 'P1',
      updatedAt: NOW,
    });
    should(lead).eql({ id: 'lead-1', mode: 'interactive', updatedAt: NOW });
    should([...(await sessions.all())].sort()).eql(['kid-1', 'lead-1']);
  });

  it('should read a session that has stopped as not live, and one that runs, or has no state yet, as live', async () => {
    // Arrange
    const storage = await open();
    for (const id of ['run-1', 'stop-1', 'new-1'])
      await storage.writeConfig(parseSessionId(id), config(id, 'interactive'));
    await storage.writeState(parseSessionId('run-1'), { id: 'run-1', status: 'running', turn: 1 });
    await storage.writeState(parseSessionId('stop-1'), { id: 'stop-1', status: 'stopped', turn: 1 });
    const sessions = new StorageHomeSessions(storage);

    // Act + Assert
    should((await sessions.get('run-1'))?.live).equal(true);
    should((await sessions.get('stop-1'))?.live).equal(false);
    should((await sessions.get('new-1'))?.live).be.undefined();
  });

  it('should read an unknown session, a malformed id and an invalid document as unreadable', async () => {
    // Arrange
    const storage = await open();
    await storage.writeConfig(parseSessionId('bad-1'), { id: 'bad-1' } as never);
    const sessions = new StorageHomeSessions(storage);

    // Act + Assert
    should(await sessions.get('missing-1')).be.undefined();
    should(await sessions.get('not valid!')).be.undefined();
    should(await sessions.get('bad-1')).be.undefined();
  });
});
