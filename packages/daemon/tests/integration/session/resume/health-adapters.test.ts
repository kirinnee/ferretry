import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  FileSelfRestartStampStore,
  FileSessionHealthEventSink,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystem,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageConsistencyPass,
  StorageSessionHealthInventory,
  SystemClock,
  SystemMonotonicClock,
  UnmountedSupervisionRepair,
  type SupervisionCapabilities,
} from '../../../../src/adapters/index.ts';
import {
  createFoundationPaths,
  createSessionPaths,
  CURRENT_SESSION_VERSION,
  defaultSessionHealthSettings,
  parseSessionId,
  resolveStateHome,
} from '../../../../src/lib/index.ts';

const homes = new Set<string>();
const NOW = '2026-07-31T10:00:00.000Z';
const SETTINGS = defaultSessionHealthSettings;

async function temporaryHome() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-health-test-'));
  homes.add(home);
  return home;
}

async function openStorage(home: string) {
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  return await factory.open();
}

function paths(home: string) {
  // FY_HOME only, and a home directory that would fail loudly if it were ever consulted: a test
  // that resolves the operator's real state home is a broken test.
  return createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
}

function capabilities(overrides: Partial<SupervisionCapabilities> = {}): SupervisionCapabilities {
  return {
    monitors: false,
    warden: false,
    monitored: () => false,
    sweepIntervalMs: 0,
    lastSweepAt: () => undefined,
    bootstrapFinished: () => true,
    bootstrapErrors: () => [],
    ...overrides,
  };
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('self-restart stamp store', () => {
  it('should report no stamp at all before anything has restarted', async () => {
    // Arrange
    const home = await temporaryHome();
    const store = new FileSelfRestartStampStore(new StateFileSystem(paths(home)), join(home, 'self-restart.json'));

    // Act
    const actual = await store.read();

    // Assert
    should(actual).be.undefined();
  });

  it('should round-trip a stamp through the real filesystem', async () => {
    // Arrange
    const home = await temporaryHome();
    const file = join(home, 'self-restart.json');
    const store = new FileSelfRestartStampStore(new StateFileSystem(paths(home)), file);

    // Act
    await store.write({ at: NOW, sessions: ['a', 'b'] });
    const actual = await store.read();

    // Assert
    should(actual).deepEqual({ at: NOW, sessions: ['a', 'b'] });
    should(JSON.parse(await readFile(file, 'utf8'))).have.property('at', NOW);
  });

  it('should throw on a corrupt stamp rather than reporting an absent one', async () => {
    // Arrange — reading a torn stamp as "nothing restarted" is what disables the restart-loop brake.
    const home = await temporaryHome();
    const file = join(home, 'self-restart.json');
    await writeFile(file, '{ this is not json', 'utf8');
    const store = new FileSelfRestartStampStore(new StateFileSystem(paths(home)), file);

    // Act / Assert
    await should(store.read()).be.rejected();
  });

  it('should throw on a stamp whose shape does not match the schema', async () => {
    // Arrange
    const home = await temporaryHome();
    const file = join(home, 'self-restart.json');
    await writeFile(file, JSON.stringify({ at: 'the other day' }), 'utf8');
    const store = new FileSelfRestartStampStore(new StateFileSystem(paths(home)), file);

    // Act / Assert
    await should(store.read()).be.rejected();
  });

  it('should clear a stamp, and stay silent when there was none to clear', async () => {
    // Arrange
    const home = await temporaryHome();
    const file = join(home, 'self-restart.json');
    const store = new FileSelfRestartStampStore(new StateFileSystem(paths(home)), file);
    await store.write({ at: NOW, sessions: [] });

    // Act
    await store.clear();
    await store.clear();

    // Assert
    should(await store.read()).be.undefined();
  });
});

describe('health event sink', () => {
  it('should append one durable stamped line per event', async () => {
    // Arrange
    const home = await temporaryHome();
    const file = join(home, 'health-events.jsonl');
    const sink = new FileSessionHealthEventSink(
      new StateFileSystem(paths(home)),
      file,
      new SystemClock(() => new Date(NOW)),
    );

    // Act
    await sink.emit({ type: 'fleet.daemon_wedge', data: { gapSeconds: 200 } });
    await sink.emit({ type: 'fleet.index_incoherent', data: { consecutive: 1 } });

    // Assert
    const lines = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    should(lines).have.length(2);
    should(lines[0]).deepEqual({ at: NOW, type: 'fleet.daemon_wedge', data: { gapSeconds: 200 } });
    should(lines[1]?.type).equal('fleet.index_incoherent');
  });
});

describe('storage health inventory', () => {
  it('should report an empty fleet with no supervision claimed', async () => {
    // Arrange
    const home = await temporaryHome();
    const opened = await openStorage(home);

    // Act
    const actual = await new StorageSessionHealthInventory(opened.storage, capabilities()).observe();

    // Assert
    should(actual.sessions).deepEqual([]);
    should(actual.supervisesMonitors).be.false();
    should(actual.supervisesWarden).be.false();
    should(actual.sweep).deepEqual({ timerArmed: false, intervalMs: 0 });
    await opened.storage.close();
  });

  it('should classify indexed sessions by status and never guess a missing one is finished', async () => {
    // Arrange
    const home = await temporaryHome();
    const opened = await openStorage(home);
    await opened.storage.writeState(parseSessionId('running-one'), { id: 'running-one', status: 'running' });
    await opened.storage.writeState(parseSessionId('stopped-one'), { id: 'stopped-one', status: 'stopped' });
    await opened.storage.writeState(parseSessionId('blank-one'), { id: 'blank-one' });

    // Act
    const actual = await new StorageSessionHealthInventory(opened.storage, capabilities()).observe();

    // Assert
    const terminal = new Map(actual.sessions.map(session => [session.id, session.terminal]));
    should(terminal.get('running-one')).be.false();
    should(terminal.get('stopped-one')).be.true();
    should(terminal.get('blank-one')).be.false();
    await opened.storage.close();
  });

  it('should consult the monitor registry only once monitors are actually mounted', async () => {
    // Arrange
    const home = await temporaryHome();
    const opened = await openStorage(home);
    await opened.storage.writeState(parseSessionId('watched'), { id: 'watched', status: 'running' });
    const sweptAt = new Date(Date.parse(NOW) - 30_000).toISOString();

    // Act
    const actual = await new StorageSessionHealthInventory(
      opened.storage,
      capabilities({
        monitors: true,
        warden: true,
        monitored: (id: string) => id === 'watched',
        sweepIntervalMs: 60_000,
        lastSweepAt: () => sweptAt,
        bootstrapErrors: () => ['one import timed out'],
      }),
    ).observe();

    // Assert
    should(actual.sessions[0]?.monitored).be.true();
    should(actual.sweep).deepEqual({ timerArmed: true, intervalMs: 60_000, lastSweepAt: sweptAt });
    should(actual.bootstrapErrors).deepEqual(['one import timed out']);
    await opened.storage.close();
  });
});

describe('storage consistency pass', () => {
  it('should reconcile nothing and touch no index when the fleet is already coherent', async () => {
    // Arrange
    const home = await temporaryHome();
    const opened = await openStorage(home);
    await opened.storage.writeState(parseSessionId('known'), { id: 'known', status: 'running' });
    const pass = new StorageConsistencyPass(opened.storage, new StateFileSystem(paths(home)), paths(home), SETTINGS);

    // Act
    const actual = await pass.run(false);

    // Assert
    should(actual).deepEqual({
      missingFromIndex: [],
      staleRows: [],
      zombies: [],
      repaired: [],
      unhealable: [],
    });
    await opened.storage.close();
  });

  it('should find a session on disk that the index lost, and repair it', async () => {
    // Arrange — the 2026-07-23 shape: a session directory whose row vanished from the index.
    const home = await temporaryHome();
    const opened = await openStorage(home);
    // A session directory laid down beside the index, exactly as one the index lost looks: the
    // directory is authoritative, and nothing in the index knows about it.
    const session = createSessionPaths(paths(home), parseSessionId('orphan'));
    await mkdir(session.directory, { recursive: true, mode: 0o700 });
    await writeFile(session.marker, `${CURRENT_SESSION_VERSION}\n`, { mode: 0o600 });
    await writeFile(session.state, JSON.stringify({ id: 'orphan', status: 'running' }), { mode: 0o600 });
    const pass = new StorageConsistencyPass(opened.storage, new StateFileSystem(paths(home)), paths(home), SETTINGS);

    // Act
    const actual = await pass.run(false);

    // Assert
    should(actual.missingFromIndex).deepEqual(['orphan']);
    should(actual.repaired).deepEqual(['orphan']);
    should(actual.unhealable).deepEqual([]);
    await opened.storage.close();
  });

  it('should report a terminal session whose journal outlived it as a zombie on a deep pass', async () => {
    // Arrange
    const home = await temporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('zombie');
    const finishedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await opened.storage.writeState(id, { id: 'zombie', status: 'stopped', finishedAt });
    // The journal keeps growing long after the session was declared finished.
    await opened.storage.append(id, 'session.late_write', { note: 'still working' });
    const pass = new StorageConsistencyPass(opened.storage, new StateFileSystem(paths(home)), paths(home), SETTINGS);

    // Act
    const actual = await pass.run(true);

    // Assert
    should(actual.zombies).deepEqual(['zombie']);
    await opened.storage.close();
  });

  it('should not look for zombies on a shallow pass', async () => {
    // Arrange
    const home = await temporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('zombie');
    await opened.storage.writeState(id, {
      id: 'zombie',
      status: 'stopped',
      finishedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    await opened.storage.append(id, 'session.late_write', { note: 'still working' });
    const pass = new StorageConsistencyPass(opened.storage, new StateFileSystem(paths(home)), paths(home), SETTINGS);

    // Act
    const actual = await pass.run(false);

    // Assert
    should(actual.zombies).deepEqual([]);
    await opened.storage.close();
  });

  it('should ignore a terminal session with no finish stamp rather than call it a zombie', async () => {
    // Arrange
    const home = await temporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('undated');
    await opened.storage.writeState(id, { id: 'undated', status: 'failed' });
    await opened.storage.append(id, 'session.late_write', { note: 'no finish stamp' });
    const pass = new StorageConsistencyPass(opened.storage, new StateFileSystem(paths(home)), paths(home), SETTINGS);

    // Act
    const actual = await pass.run(true);

    // Assert
    should(actual.zombies).deepEqual([]);
    await opened.storage.close();
  });

  it('should read the journal for a session whose events file does not exist yet', async () => {
    // Arrange
    const home = await temporaryHome();
    const opened = await openStorage(home);
    const id = parseSessionId('quiet');
    await opened.storage.writeState(id, { id: 'quiet', status: 'stopped', finishedAt: NOW });
    should(createSessionPaths(paths(home), id).events).be.a.String();
    const pass = new StorageConsistencyPass(opened.storage, new StateFileSystem(paths(home)), paths(home), SETTINGS);

    // Act
    const actual = await pass.run(true);

    // Assert
    should(actual.zombies).deepEqual([]);
    await opened.storage.close();
  });
});

describe('unmounted supervision repair', () => {
  it('should refuse loudly rather than pretend a repair happened', async () => {
    // Arrange
    const repair = new UnmountedSupervisionRepair();

    // Act / Assert
    await should(repair.startMonitor('any')).be.rejectedWith(/no session monitor subsystem is mounted/u);
    await should(repair.rearmWarden()).be.rejectedWith(/no warden sweep timer is mounted/u);
  });
});

describe('system monotonic clock', () => {
  it('should never go backwards between two readings', async () => {
    // Arrange
    const clock = new SystemMonotonicClock();

    // Act
    const first = clock.elapsedMs();
    await Bun.sleep(2);
    const second = clock.elapsedMs();

    // Assert
    should(second).be.greaterThanOrEqual(first);
    should(Number.isFinite(first)).be.true();
  });
});
