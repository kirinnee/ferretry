import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_EVENT_TYPES, TaskRefSchema } from '@ferretry/protocol';
import should from 'should';
import {
  JournalBoardChanges,
  StorageSessionFocus,
  StorageSessionParents,
} from '../../../src/adapters/board/session-board-adapters.ts';
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
import { jsonObject } from '../../../src/lib/json.ts';
import { parseSessionId } from '../../../src/lib/index.ts';

/**
 * The board's session-side adapters over a real state home: lineage from `config.parent`, the focus
 * card in `config.focusTask`, and `board.changed` in the writer's journal. Temp `FY_HOME`; no daemon.
 */

const homes = new Set<string>();
const storages = new Set<{ close(): Promise<void> | void }>();
const NOW = '2026-10-30T10:00:00.000Z';

async function openStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-board-sessions-'));
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

async function session(storage: Awaited<ReturnType<typeof openStorage>>, id: string, parent?: string) {
  const sessionId = parseSessionId(id);
  await storage.writeConfig(sessionId, {
    id,
    name: id,
    agent: '/opt/fleet/bin/claude',
    command: ['/opt/fleet/bin/claude'],
    cwd: '/workspace/project',
    mode: 'auto',
    turn: 1,
    tmuxSession: `fy-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...(parent === undefined ? {} : { parent }),
  });
  await storage.writeState(sessionId, { id, status: 'running', turn: 1 });
  return sessionId;
}

afterEach(async () => {
  for (const storage of storages) await storage.close();
  storages.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the board session adapters', () => {
  it('should read a session parent, and nothing for a root, an unknown or an unusable session', async () => {
    // Arrange
    const storage = await openStorage();
    await session(storage, 'lead');
    await session(storage, 'child', 'lead');
    const parents = new StorageSessionParents(storage);

    // Act
    const found = await Promise.all(['child', 'lead', 'ghost', '../escape'].map(id => parents.parentOf(id)));

    // Assert
    should(found).eql(['lead', undefined, undefined, undefined]);
  });

  it('should write the focus card into the config, keeping every other field, and read it back', async () => {
    // Arrange
    const storage = await openStorage();
    const id = await session(storage, 'lead');
    const focus = new StorageSessionFocus(storage);

    // Act
    const before = await focus.focusOf('lead');
    const written = await focus.setFocus('lead', { id: 'F12' });
    const after = await focus.focusOf('lead');
    const config = jsonObject(await storage.readConfig(id));

    // Assert
    should(before).be.null();
    should(written).be.true();
    should(after).eql({ id: 'F12' });
    should(config).match({ name: 'lead', tmuxSession: 'fy-lead' });
    should(TaskRefSchema.parse(config?.focusTask)).eql({ id: 'F12' });
  });

  it('should not focus a session the daemon does not hold', async () => {
    // Arrange
    const storage = await openStorage();
    const focus = new StorageSessionFocus(storage);

    // Act
    const written = await focus.setFocus('ghost', { id: 'F12' });
    const read = await focus.focusOf('ghost');

    // Assert
    should(written).be.false();
    should(read).be.null();
  });

  it('should journal board.changed on the writer session, and drop it for a session it does not hold', async () => {
    // Arrange
    const storage = await openStorage();
    const id = await session(storage, 'lead');
    const changes = new JournalBoardChanges(storage);
    const event = { projectId: 'unfiled' as const, taskIds: ['F12'] };

    // Act
    await changes.changed('lead', event);
    await changes.changed('ghost', event);
    const journal = (await storage.replay(id)).events.filter(entry => entry.type === BOARD_EVENT_TYPES.changed);

    // Assert
    should(journal.map(entry => entry.data)).eql([event]);
  });
});
