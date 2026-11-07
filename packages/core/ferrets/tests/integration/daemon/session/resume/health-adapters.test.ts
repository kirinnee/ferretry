import { describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import { FerretHistoryFiles } from '../../../../../contract/index.ts';
import { FileSelfRestartStampStore } from '../../../../../daemon/adapters/session/resume/file-self-restart-stamp-store.ts';
import { FileSessionHealthEventSink } from '../../../../../daemon/adapters/session/resume/file-health-event-sink.ts';
import { StorageConsistencyPass } from '../../../../../daemon/adapters/session/resume/storage-consistency-pass.ts';
import {
  StorageSessionHealthInventory,
  type SupervisionCapabilities,
} from '../../../../../daemon/adapters/session/resume/storage-health-inventory.ts';
import { SystemMonotonicClock } from '../../../../../daemon/adapters/session/resume/system-monotonic-clock.ts';
import { UnmountedSupervisionRepair } from '../../../../../daemon/adapters/session/resume/unmounted-repair.ts';
import { createSessionPaths } from '../../../../../daemon/lib/paths.ts';
import { defaultSessionHealthSettings } from '../../../../../daemon/lib/session/health/settings.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { SessionStateFiles } from '../../../../../daemon/lib/state.ts';
import { MEMORY_PATHS, MemoryFileSystem } from '../../../../support/daemon/memory-file-system.ts';
import { memoryStorage, sessionConfig, sessionState } from '../../../../support/daemon/storage.ts';
import { waitForValue } from '../../support/wait-for.ts';

/**
 * The health adapters: the self-restart stamp and the health event file (a `FileSystemPort`, here in memory), the
 * inventory and the consistency pass over the session store (the kernel's memory state folder).
 *
 * The consistency pass still reads a journal's last write through the filesystem, at the session directory's
 * `events.jsonl`, so a test that needs a journal to have outlived its session lays that file down in the memory
 * filesystem at the instant it wants.
 */

const NOW = '2026-07-31T10:00:00.000Z';
const SETTINGS = defaultSessionHealthSettings;
const HOME = MEMORY_PATHS.home;

/** A filesystem whose writes are stamped from NOW on, so a journal written now is newer than anything before. */
function memoryFiles(): MemoryFileSystem {
  return new MemoryFileSystem(Date.parse(NOW));
}

async function openStorage() {
  return await memoryStorage({ clock: { now: () => NOW } });
}

function capabilities(overrides: Partial<SupervisionCapabilities> = {}): SupervisionCapabilities {
  return {
    monitors: false,
    warden: false,
    monitored: () => false,
    sweepIntervalMs: 0,
    armedAtMs: () => undefined,
    lastSweepAt: () => undefined,
    bootstrapFinished: () => true,
    bootstrapErrors: () => [],
    ...overrides,
  };
}

const TEN_MINUTES_BEFORE = new Date(Date.parse(NOW) - 10 * 60_000).toISOString();

describe('self-restart stamp store', () => {
  it('should report no stamp at all before anything has restarted', async () => {
    // Arrange
    const store = new FileSelfRestartStampStore(memoryFiles(), join(HOME, 'self-restart.json'));

    // Act
    const actual = await store.read();

    // Assert
    should(actual).be.undefined();
  });

  it('should round-trip a stamp through the filesystem', async () => {
    // Arrange
    const files = memoryFiles();
    const file = join(HOME, 'self-restart.json');
    const store = new FileSelfRestartStampStore(files, file);

    // Act
    await store.write({ at: NOW, sessions: ['a', 'b'] });
    const actual = await store.read();

    // Assert
    should(actual).deepEqual({ at: NOW, sessions: ['a', 'b'] });
    should(JSON.parse(files.text(file) ?? 'null')).have.property('at', NOW);
  });

  it('should throw on a corrupt stamp rather than reporting an absent one', async () => {
    // Arrange — reading a torn stamp as "nothing restarted" is what disables the restart-loop brake.
    const files = memoryFiles();
    const file = join(HOME, 'self-restart.json');
    files.plant(file, '{ this is not json');
    const store = new FileSelfRestartStampStore(files, file);

    // Act / Assert
    await should(store.read()).be.rejected();
  });

  it('should throw on a stamp whose shape does not match the schema', async () => {
    // Arrange
    const files = memoryFiles();
    const file = join(HOME, 'self-restart.json');
    files.plant(file, JSON.stringify({ at: 'the other day' }));
    const store = new FileSelfRestartStampStore(files, file);

    // Act / Assert
    await should(store.read()).be.rejected();
  });

  it('should clear a stamp, and stay silent when there was none to clear', async () => {
    // Arrange
    const store = new FileSelfRestartStampStore(memoryFiles(), join(HOME, 'self-restart.json'));
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
    const files = memoryFiles();
    const file = join(HOME, 'health-events.jsonl');
    const sink = new FileSessionHealthEventSink(files, file, { now: () => NOW });

    // Act
    await sink.emit({ type: 'fleet.daemon_wedge', data: { gapSeconds: 200 } });
    await sink.emit({ type: 'fleet.index_incoherent', data: { consecutive: 1 } });

    // Assert
    const lines = (files.text(file) ?? '')
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
    const opened = await openStorage();

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
    // Arrange — `blank-one` has a configuration and no state, so the index knows no status for it.
    const opened = await openStorage();
    await opened.storage.writeState(parseSessionId('running-one'), sessionState('running-one', { status: 'running' }));
    await opened.storage.writeState(parseSessionId('stopped-one'), sessionState('stopped-one', { status: 'stopped' }));
    await opened.storage.writeConfig(parseSessionId('blank-one'), sessionConfig('blank-one'));

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
    const opened = await openStorage();
    await opened.storage.writeState(parseSessionId('watched'), sessionState('watched', { status: 'running' }));
    const armedAtMs = Date.parse(NOW) - 45_000;
    const sweptAt = new Date(Date.parse(NOW) - 30_000).toISOString();

    // Act
    const actual = await new StorageSessionHealthInventory(
      opened.storage,
      capabilities({
        monitors: true,
        warden: true,
        monitored: (id: string) => id === 'watched',
        sweepIntervalMs: 60_000,
        armedAtMs: () => armedAtMs,
        lastSweepAt: () => sweptAt,
        bootstrapErrors: () => ['one import timed out'],
      }),
    ).observe();

    // Assert
    should(actual.sessions[0]?.monitored).be.true();
    should(actual.sweep).deepEqual({ timerArmed: true, intervalMs: 60_000, armedAtMs, lastSweepAt: sweptAt });
    should(actual.bootstrapErrors).deepEqual(['one import timed out']);
    await opened.storage.close();
  });
});

describe('storage consistency pass', () => {
  it('should reconcile nothing and touch no index when the fleet is already coherent', async () => {
    // Arrange
    const opened = await openStorage();
    await opened.storage.writeState(parseSessionId('known'), sessionState('known', { status: 'running' }));
    const pass = new StorageConsistencyPass(opened.storage, SETTINGS);

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
    should(await opened.storage.surveySessionDirectories()).deepEqual([{ id: 'known', journalLost: false }]);
    await opened.storage.close();
  });

  it('should find a session on disk that the index lost, and repair it', async () => {
    // Arrange — the 2026-07-23 shape: a session whose row vanished from the index while its documents stayed.
    const opened = await openStorage();
    const orphan = parseSessionId('orphan');
    await opened.storage.writeState(orphan, sessionState('orphan', { status: 'running' }));
    opened.storage.forgetFromIndex(orphan);
    const pass = new StorageConsistencyPass(opened.storage, SETTINGS);

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
    const opened = await openStorage();
    const id = parseSessionId('zombie');
    await opened.storage.writeState(id, sessionState('zombie', { status: 'stopped', finishedAt: TEN_MINUTES_BEFORE }));
    // The journal keeps growing long after the session was declared finished.
    await opened.storage.append(id, 'session.late_write', { note: 'still working' });
    const pass = new StorageConsistencyPass(opened.storage, SETTINGS);

    // Act
    const actual = await pass.run(true);

    // Assert
    should(actual.zombies).deepEqual(['zombie']);
    await opened.storage.close();
  });

  it('should name the zombie scan, the reindex and its verification as stages of a deep pass', async () => {
    // Arrange
    const opened = await openStorage();
    await opened.storage.writeState(parseSessionId('known'), sessionState('known', { status: 'running' }));
    const stages: string[] = [];
    const pass = new StorageConsistencyPass(opened.storage, SETTINGS, {
      run: async (name, work) => {
        stages.push(name);
        return await work();
      },
    });

    // Act
    await pass.run(true);
    const deep = [...stages];
    stages.length = 0;
    await pass.run(false);

    // Assert — a shallow pass over a coherent fleet has no stage worth naming.
    should(deep).deepEqual(['zombies', 'reindex', 'verify']);
    should(stages).deepEqual([]);
    await opened.storage.close();
  });

  it('should compare the index against the walk it is handed rather than taking its own', async () => {
    // Arrange — the session is stored and indexed; only the handed walk says otherwise.
    const opened = await openStorage();
    await opened.storage.writeState(parseSessionId('known'), sessionState('known', { status: 'running' }));
    const pass = new StorageConsistencyPass(opened.storage, SETTINGS);

    // Act
    const handed = await pass.run(false, []);
    const own = await pass.run(false, await opened.storage.surveySessionDirectories());

    // Assert
    should(handed.staleRows).deepEqual(['known']);
    should(own.staleRows).deepEqual([]);
    await opened.storage.close();
  });

  it('should not look for zombies on a shallow pass', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('zombie');
    await opened.storage.writeState(id, sessionState('zombie', { status: 'stopped', finishedAt: TEN_MINUTES_BEFORE }));
    await opened.storage.append(id, 'session.late_write', { note: 'still working' });
    const pass = new StorageConsistencyPass(opened.storage, SETTINGS);

    // Act
    const actual = await pass.run(false);

    // Assert
    should(actual.zombies).deepEqual([]);
    await opened.storage.close();
  });

  it('should report a vanished indexed journal as unhealable instead of healthy', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('lost-journal');
    await opened.storage.append(id, 'session.started', { durable: true });
    // The session still exists on disk through its state document; only its journal (the history file) is gone. A
    // session whose history was its only file has nothing left to be found lost.
    await opened.storage.writeState(id, sessionState(id, { status: 'running' }));
    opened.folder.files.delete(FerretHistoryFiles.path.replace('*', id));
    const pass = new StorageConsistencyPass(opened.storage, SETTINGS);

    // Act
    const actual = await pass.run(true);

    // Assert — membership alone is not health evidence when reconciliation could not read the
    // journal. The stale index row is deliberately retained so it cannot become an empty session.
    should(actual.missingFromIndex).deepEqual([]);
    should(actual.repaired).deepEqual([]);
    should(actual.unhealable).deepEqual([id]);
    should(opened.storage.findSession(id)?.lastSequence).equal(1);
    await opened.storage.close();
  });

  it('should keep reporting a lost journal on every shallow tick without reconciling again', async () => {
    // Arrange — a healthy deep pass first, so the finding can only come from the deletion.
    const opened = await openStorage();
    const lost = parseSessionId('lost-journal');
    const healthy = parseSessionId('healthy-session');
    await opened.storage.append(lost, 'session.started', { durable: true });
    await opened.storage.writeState(lost, sessionState(lost, { status: 'running' }));
    await opened.storage.append(healthy, 'session.started', { durable: true });
    const pass = new StorageConsistencyPass(opened.storage, SETTINGS);
    const healthyPass = await pass.run(true);
    opened.folder.files.delete(FerretHistoryFiles.path.replace('*', lost));
    const reconcile = opened.storage.reconcile.bind(opened.storage);
    let reconciles = 0;
    opened.storage.reconcile = async () => {
      reconciles += 1;
      return await reconcile();
    };

    // Act
    const shallow = [await pass.run(false), await pass.run(false), await pass.run(false)];

    // Assert — the finding survives every ordinary tick, so the restart streak can never be reset
    // by one, and no tick pays for a reconcile it cannot possibly heal.
    should(healthyPass.unhealable).deepEqual([]);
    should(shallow.map(tick => tick.unhealable)).deepEqual([[lost], [lost], [lost]]);
    should(shallow.map(tick => tick.missingFromIndex)).deepEqual([[], [], []]);
    should(reconciles).equal(0);
    should(opened.storage.findSession(healthy)?.lastSequence).equal(1);
    await opened.storage.close();
  });

  it('should ignore a terminal session with no finish stamp rather than call it a zombie', async () => {
    // Arrange
    const opened = await openStorage();
    const id = parseSessionId('undated');
    await opened.storage.writeState(id, sessionState('undated', { status: 'failed' }));
    await opened.storage.append(id, 'session.late_write', { note: 'no finish stamp' });
    const pass = new StorageConsistencyPass(opened.storage, SETTINGS);

    // Act
    const actual = await pass.run(true);

    // Assert
    should(actual.zombies).deepEqual([]);
    await opened.storage.close();
  });

  it('should not call a terminal session a zombie when its state record can no longer be read', async () => {
    // Arrange — without the finish stamp there is nothing to compare the journal's last write against.
    const opened = await openStorage();
    const id = parseSessionId('torn-state');
    await opened.storage.writeState(
      id,
      sessionState('torn-state', { status: 'stopped', finishedAt: TEN_MINUTES_BEFORE }),
    );
    await opened.storage.append(id, 'session.late_write', { note: 'still working' });
    opened.folder.plant(SessionStateFiles, '{"id": "torn-state"', id);
    const pass = new StorageConsistencyPass(opened.storage, SETTINGS);

    // Act
    const actual = await pass.run(true);

    // Assert
    should(actual.zombies).deepEqual([]);
    await opened.storage.close();
  });

  it('should not call a finished session with an untouched empty journal a zombie', async () => {
    // Arrange — a session that recorded no events still has a real, zero-length journal, and its
    // creation timestamp must not read as activity outliving the session.
    const opened = await openStorage();
    const files = memoryFiles();
    const id = parseSessionId('quiet');
    await opened.storage.writeState(id, sessionState('quiet', { status: 'stopped', finishedAt: NOW }));
    files.plant(createSessionPaths(MEMORY_PATHS, id).events, '');
    const journal = await files.information(createSessionPaths(MEMORY_PATHS, id).events);
    const pass = new StorageConsistencyPass(opened.storage, SETTINGS);

    // Act
    const actual = await pass.run(true);

    // Assert
    should(journal?.size).equal(0);
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
    const second = await waitForValue(() => {
      const reading = clock.elapsedMs();
      return reading > first ? reading : undefined;
    }, 'the monotonic clock to advance');

    // Assert
    should(second).be.greaterThanOrEqual(first);
    should(Number.isFinite(first)).be.true();
  });
});
