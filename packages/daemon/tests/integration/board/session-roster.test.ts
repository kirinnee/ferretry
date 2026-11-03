import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StorageSessionRoster } from '../../../src/adapters/board/session-roster.ts';
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
import { createFoundationPaths, createSessionPaths, parseSessionId } from '../../../src/lib/index.ts';
import type { WardenLivenessLedger } from '../../../src/lib/warden/types.ts';

/**
 * The board's session roster over a real state home: one pass over the index, each session's focus card
 * from its configuration and its life-signs from its state, with the Warden's ledger laid over them.
 * Temp `FY_HOME`; no daemon.
 */

const homes = new Set<string>();
const storages = new Set<{ close(): Promise<void> | void }>();
const NOW = '2026-10-30T10:00:00.000Z';
const EARLIER = '2026-10-30T09:00:00.000Z';
const LATER = '2026-10-30T09:59:00.000Z';

async function openStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-board-roster-'));
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

type Storage = Awaited<ReturnType<typeof openStorage>>;

async function session(
  storage: Storage,
  id: string,
  state: Record<string, unknown>,
  config: Record<string, unknown> = {},
): Promise<void> {
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
    ...config,
  });
  await storage.writeState(sessionId, { id, turn: 1, ...state });
}

afterEach(async () => {
  for (const storage of storages) await storage.close();
  storages.clear();
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the board session roster', () => {
  it("should read each session's focus, status, turn, declared wait and life-signs", async () => {
    // Arrange
    const storage = await openStorage();
    await session(
      storage,
      'lead',
      {
        status: 'running',
        turnState: 'working',
        waiting: { since: EARLIER, condition: 'a teammate' },
        lastActivityAt: EARLIER,
        lastTranscriptAt: EARLIER,
        lastTokenAdvanceAt: EARLIER,
        lastSubprocessAt: EARLIER,
        subprocessSince: EARLIER,
      },
      { focusTask: { id: 'F12' } },
    );
    await session(storage, 'child', { status: 'completed', turnState: 'sideways', lastTranscriptAt: 'yesterday' });

    // Act
    const roster = await new StorageSessionRoster(storage, () => undefined).roster();

    // Assert
    should([...roster.held].sort()).eql(['child', 'lead']);
    should(roster.sessions.get('lead')).eql({
      id: 'lead',
      status: 'running',
      turnState: 'working',
      focusTask: { id: 'F12' },
      declaredWait: true,
      lastActivityAt: EARLIER,
      lastTranscriptAt: EARLIER,
      lastTokenAdvanceAt: EARLIER,
      lastSubprocessAt: EARLIER,
      subprocessSince: EARLIER,
    });
    should(roster.sessions.get('child')).eql({
      id: 'child',
      status: 'completed',
      focusTask: null,
      declaredWait: false,
    });
  });

  it("should lay the Warden's ledger over the documents, the later signal winning", async () => {
    // Arrange
    const storage = await openStorage();
    await session(storage, 'lead', { status: 'running', lastTranscriptAt: LATER, lastTokenAdvanceAt: EARLIER });
    const ledger: WardenLivenessLedger = {
      lastTranscriptAt: EARLIER,
      lastTokenAdvanceAt: LATER,
      subprocessSince: LATER,
      lastSubprocessAt: LATER,
    };

    // Act
    const roster = await new StorageSessionRoster(storage, id => (id === 'lead' ? ledger : undefined)).roster();

    // Assert
    should(roster.sessions.get('lead')).match({
      lastTranscriptAt: LATER,
      lastTokenAdvanceAt: LATER,
      lastSubprocessAt: LATER,
      subprocessSince: LATER,
    });
  });

  it('should see a state written outside the daemon on the next read, though the last read was memoized', async () => {
    // Arrange
    const storage = await openStorage();
    await session(storage, 'lead', { status: 'running', lastActivityAt: EARLIER });
    const roster = new StorageSessionRoster(storage, () => undefined);
    await roster.roster();
    await roster.roster();

    // Act — an editor (or a second process) rewrites state.json behind the daemon's back.
    const home = [...homes].at(-1) as string;
    const file = createSessionPaths(createFoundationPaths(home as never), parseSessionId('lead')).state;
    await writeFile(file, `${JSON.stringify({ id: 'lead', turn: 1, status: 'completed', lastActivityAt: LATER })}\n`);
    const read = await roster.roster();

    // Assert
    should(read.sessions.get('lead')).match({ status: 'completed', lastActivityAt: LATER });
  });

  it('should hold a session it cannot read without calling it alive or dead', async () => {
    // Arrange
    const storage = await openStorage();
    await session(storage, 'lead', { status: 'running' });
    await session(storage, 'odd', { status: 'not-a-status' });
    await session(storage, 'broken', { status: 'running' });
    const reading = {
      listSessions: () => storage.listSessions(),
      holdSessions: storage.holdSessions.bind(storage),
      readConfig: storage.readConfig.bind(storage),
      readState: async (id: Parameters<Storage['readState']>[0]) => {
        if (id === 'broken') throw new Error('unreadable');
        return await storage.readState(id);
      },
    };

    // Act
    const roster = await new StorageSessionRoster(reading, () => undefined).roster();

    // Assert
    should([...roster.held].sort()).eql(['broken', 'lead', 'odd']);
    should([...roster.sessions.keys()]).eql(['lead']);
  });
});

describe('the board session roster, settled', () => {
  it('should hand the work what is on disk now, though the last read was memoized and unheard', async () => {
    // Arrange
    const storage = await openStorage();
    await session(storage, 'lead', { status: 'running', lastActivityAt: EARLIER });
    const roster = new StorageSessionRoster(storage, () => undefined);
    await roster.roster();
    const home = [...homes].at(-1) as string;
    const file = createSessionPaths(createFoundationPaths(home as never), parseSessionId('lead')).state;
    await writeFile(file, `${JSON.stringify({ id: 'lead', turn: 1, status: 'completed', lastActivityAt: LATER })}\n`);

    // Act
    const settled = await roster.settled(['lead'], async fresh => fresh);

    // Assert
    should([...settled.held]).eql(['lead']);
    should(settled.sessions.get('lead')).match({ status: 'completed', lastActivityAt: LATER });
  });

  it('should read only the named sessions, and call a name the index does not hold gone', async () => {
    // Arrange
    const storage = await openStorage();
    await session(storage, 'lead', { status: 'running' });
    await session(storage, 'child', { status: 'running' });
    await session(storage, 'bystander', { status: 'running' });

    // Act
    const settled = await new StorageSessionRoster(storage, () => undefined).settled(
      ['lead', 'child', 'ghost'],
      async fresh => fresh,
    );

    // Assert
    should([...settled.held].sort()).eql(['child', 'lead']);
    should([...settled.sessions.keys()].sort()).eql(['child', 'lead']);
  });

  it("should lay the Warden's ledger over a settled session", async () => {
    // Arrange
    const storage = await openStorage();
    await session(storage, 'lead', { status: 'running', lastTranscriptAt: EARLIER });
    const ledger: WardenLivenessLedger = { lastTranscriptAt: LATER };

    // Act
    const settled = await new StorageSessionRoster(storage, () => ledger).settled(['lead'], async fresh => fresh);

    // Assert
    should(settled.sessions.get('lead')).match({ status: 'running', lastTranscriptAt: LATER });
  });

  it('should hold a settled session it cannot read without calling it alive or dead', async () => {
    // Arrange
    const storage = await openStorage();
    await session(storage, 'lead', { status: 'running' });
    await session(storage, 'broken', { status: 'running' });
    const reading = {
      listSessions: () => storage.listSessions(),
      holdSessions: storage.holdSessions.bind(storage),
      readConfig: storage.readConfig.bind(storage),
      readState: async (id: Parameters<Storage['readState']>[0], freshness?: Parameters<Storage['readState']>[1]) => {
        if (id === 'broken') throw new Error('unreadable');
        return await storage.readState(id, freshness);
      },
    };

    // Act
    const settled = await new StorageSessionRoster(reading, () => undefined).settled(
      ['lead', 'broken'],
      async fresh => fresh,
    );

    // Assert
    should([...settled.held].sort()).eql(['broken', 'lead']);
    should([...settled.sessions.keys()]).eql(['lead']);
  });

  it('should keep the named sessions still while the work runs, and let other sessions write', async () => {
    // Arrange
    const storage = await openStorage();
    await session(storage, 'lead', { status: 'running' });
    await session(storage, 'child', { status: 'running' });
    await session(storage, 'other', { status: 'running' });
    const order: string[] = [];
    let release = (): void => undefined;
    const finish = new Promise<void>(done => {
      release = done;
    });
    let proceed = (): void => undefined;
    const started = new Promise<void>(resolve => {
      proceed = resolve;
    });

    // Act
    const work = new StorageSessionRoster(storage, () => undefined).settled(['lead', 'child'], async fresh => {
      proceed();
      await finish;
      order.push('work');
      return fresh.sessions.get('child')?.status;
    });
    await started;
    const later = storage
      .writeState(parseSessionId('child'), { id: 'child', turn: 1, status: 'completed' })
      .then(() => void order.push('later write'));
    await storage.writeState(parseSessionId('other'), { id: 'other', turn: 1, status: 'completed' });
    order.push('other write');
    release();
    const seen = await work;
    await later;

    // Assert
    should(seen).equal('running');
    should(order).eql(['other write', 'work', 'later write']);
  });

  it('should release the named sessions when the work throws', async () => {
    // Arrange
    const storage = await openStorage();
    await session(storage, 'lead', { status: 'running' });
    const roster = new StorageSessionRoster(storage, () => undefined);

    // Act
    const failed = await roster
      .settled(['lead'], async () => {
        throw new Error('commit refused');
      })
      .catch((error: unknown) => (error as Error).message);
    await storage.writeState(parseSessionId('lead'), { id: 'lead', turn: 1, status: 'completed' });

    // Assert
    should(failed).equal('commit refused');
    should((await roster.settled(['lead'], async fresh => fresh)).sessions.get('lead')).match({ status: 'completed' });
  });
});
