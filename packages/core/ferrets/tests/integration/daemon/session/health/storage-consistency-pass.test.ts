import { describe, it } from 'bun:test';
import should from 'should';
import { FerretHistoryFiles } from '../../../../../contract/index.ts';
import {
  StorageConsistencyPass,
  type SupervisionCapabilities,
  StorageSessionHealthInventory,
} from '../../../../../daemon/adapters/session/health/index.ts';
import { defaultSessionHealthSettings } from '../../../../../daemon/lib/session/health/settings.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { memoryStorage, SESSION_STORE_FILES, sessionState } from '../../../../support/daemon/storage.ts';

/**
 * The session index is a disposable cache of the session folders, and the self-check's two readers of it: what the
 * fleet looks like (the inventory) and whether the index still agrees with the folders (the consistency pass).
 * Everything runs on the kernel test host's memory state; the clock is the test's own.
 */

const SETTINGS = defaultSessionHealthSettings;
const NOW = '2026-07-31T10:00:00.000Z';
const NOW_MS = Date.parse(NOW);

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

/** A storage whose own clock the test sets: it stamps every journal event, which is when a journal last grew. */
async function fleet(initial = NOW_MS) {
  let nowMs = initial;
  const opened = await memoryStorage({ clock: { now: () => new Date(nowMs).toISOString() } });
  return {
    ...opened,
    at: (ms: number) => {
      nowMs = ms;
    },
    pass: (stages?: ConstructorParameters<typeof StorageConsistencyPass>[2]) =>
      new StorageConsistencyPass(opened.storage, SETTINGS, stages),
  };
}

describe('storage health inventory', () => {
  it('should report an empty fleet with no supervision claimed', async () => {
    // Arrange
    const { storage } = await fleet();

    // Act
    const actual = await new StorageSessionHealthInventory(storage, capabilities()).observe();

    // Assert
    should(actual.sessions).deepEqual([]);
    should(actual.supervisesMonitors).be.false();
    should(actual.supervisesWarden).be.false();
    should(actual.sweep).deepEqual({ timerArmed: false, intervalMs: 0 });
  });

  it('should classify indexed sessions by status and never guess a missing one is finished', async () => {
    // Arrange
    const { storage } = await fleet();
    await storage.writeState(parseSessionId('running-one'), sessionState('running-one', { status: 'running' }));
    await storage.writeState(parseSessionId('stopped-one'), sessionState('stopped-one', { status: 'stopped' }));
    // An index row that lost its status: a state document must carry one, so the row is handed in as it would read.
    const blank = { id: parseSessionId('blank-one'), lastSequence: 0, journalLine: 0, journal: null };

    // Act
    const actual = await new StorageSessionHealthInventory(
      { listSessions: () => [...storage.listSessions(), blank] },
      capabilities(),
    ).observe();

    // Assert
    const terminal = new Map(actual.sessions.map(session => [session.id, session.terminal]));
    should(terminal.get('running-one')).be.false();
    should(terminal.get('stopped-one')).be.true();
    should(terminal.get('blank-one')).be.false();
  });

  it('should consult the monitor registry only once monitors are actually mounted', async () => {
    // Arrange
    const { storage } = await fleet();
    await storage.writeState(parseSessionId('watched'), sessionState('watched', { status: 'running' }));
    const armedAtMs = NOW_MS - 45_000;
    const sweptAt = new Date(NOW_MS - 30_000).toISOString();

    // Act
    const actual = await new StorageSessionHealthInventory(
      storage,
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
  });
});

describe('storage consistency pass', () => {
  it('should reconcile nothing and touch no index when the fleet is already coherent', async () => {
    // Arrange
    const { storage, pass } = await fleet();
    await storage.writeState(parseSessionId('known'), sessionState('known'));

    // Act
    const actual = await pass().run(false);

    // Assert
    should(actual).deepEqual({ missingFromIndex: [], staleRows: [], zombies: [], repaired: [], unhealable: [] });
  });

  it('should find a session the index lost, and repair it', async () => {
    // Arrange — a session whose folder is there and whose index row is not.
    const { storage, pass } = await fleet();
    const id = parseSessionId('orphan');
    await storage.writeState(id, sessionState('orphan'));
    storage.forgetFromIndex(id);

    // Act
    const actual = await pass().run(false);

    // Assert
    should(actual.missingFromIndex).deepEqual(['orphan']);
    should(actual.repaired).deepEqual(['orphan']);
    should(actual.unhealable).deepEqual([]);
    should(storage.findSession(id)).not.be.undefined();
  });

  it('should report a terminal session whose journal outlived it as a zombie on a deep pass', async () => {
    // Arrange — finished ten minutes ago by its own stamp, and its journal written to just now.
    const { storage, at, pass } = await fleet();
    const id = parseSessionId('zombie');
    await storage.writeState(
      id,
      sessionState('zombie', { status: 'stopped', finishedAt: new Date(NOW_MS - 10 * 60_000).toISOString() }),
    );
    at(NOW_MS);
    await storage.append(id, 'session.late_write', { note: 'still working' });

    // Act
    const actual = await pass().run(true);

    // Assert
    should(actual.zombies).deepEqual(['zombie']);
  });

  it('should name the zombie scan, the reindex and its verification as stages of a deep pass', async () => {
    // Arrange
    const { storage, pass } = await fleet();
    await storage.writeState(parseSessionId('known'), sessionState('known'));
    const stages: string[] = [];
    const named = pass({
      run: async (name, work) => {
        stages.push(name);
        return await work();
      },
    });

    // Act
    await named.run(true);
    const deep = [...stages];
    stages.length = 0;
    await named.run(false);

    // Assert — a shallow pass over a coherent fleet has no stage worth naming.
    should(deep).deepEqual(['zombies', 'reindex', 'verify']);
    should(stages).deepEqual([]);
  });

  it('should compare the index against the walk it is handed rather than taking its own', async () => {
    // Arrange — the session is on disk and indexed; only the handed walk says otherwise.
    const { storage, pass } = await fleet();
    await storage.writeState(parseSessionId('known'), sessionState('known'));

    // Act
    const handed = await pass().run(false, []);
    const own = await pass().run(false, await storage.surveySessionDirectories());

    // Assert
    should(handed.staleRows).deepEqual(['known']);
    should(own.staleRows).deepEqual([]);
  });

  it('should not look for zombies on a shallow pass', async () => {
    // Arrange
    const { storage, pass } = await fleet();
    const id = parseSessionId('zombie');
    await storage.writeState(
      id,
      sessionState('zombie', { status: 'stopped', finishedAt: new Date(NOW_MS - 10 * 60_000).toISOString() }),
    );
    await storage.append(id, 'session.late_write', { note: 'still working' });

    // Act
    const actual = await pass().run(false);

    // Assert
    should(actual.zombies).deepEqual([]);
  });

  it('should report a vanished indexed journal as unhealable instead of healthy', async () => {
    // Arrange
    const { storage, folder, pass } = await fleet();
    const id = parseSessionId('lost-journal');
    await storage.writeState(id, sessionState(id));
    await storage.append(id, 'session.started', { durable: true });
    await folder.port(SESSION_STORE_FILES).remove(FerretHistoryFiles, id);

    // Act
    const actual = await pass().run(true);

    // Assert — membership alone is not health evidence when reconciliation could not read the journal. The stale
    // index row is deliberately retained so it cannot become an empty session.
    should(actual.missingFromIndex).deepEqual([]);
    should(actual.repaired).deepEqual([]);
    should(actual.unhealable).deepEqual([id]);
    should(storage.findSession(id)?.lastSequence).equal(1);
  });

  it('should keep reporting a lost journal on every shallow tick without reconciling again', async () => {
    // Arrange — a healthy deep pass first, so the finding can only come from the deletion.
    const { storage, folder, pass } = await fleet();
    const lost = parseSessionId('lost-journal');
    const healthy = parseSessionId('healthy-session');
    for (const id of [lost, healthy]) await storage.writeState(id, sessionState(id));
    await storage.append(lost, 'session.started', { durable: true });
    await storage.append(healthy, 'session.started', { durable: true });
    const healthyPass = await pass().run(true);
    await folder.port(SESSION_STORE_FILES).remove(FerretHistoryFiles, lost);
    let reconciles = 0;
    const counting = new StorageConsistencyPass(
      {
        listSessions: () => storage.listSessions(),
        surveySessionDirectories: async () => await storage.surveySessionDirectories(),
        sessionIdsOnDisk: async () => await storage.sessionIdsOnDisk(),
        readState: async id => await storage.readState(id),
        lastEventAt: id => storage.lastEventAt(id),
        reconcile: async () => {
          reconciles += 1;
          return await storage.reconcile();
        },
      },
      SETTINGS,
    );

    // Act
    const shallow = [await counting.run(false), await counting.run(false), await counting.run(false)];

    // Assert — the finding survives every ordinary tick, so the restart streak can never be reset by one, and no tick
    // pays for a reconcile it cannot possibly heal.
    should(healthyPass.unhealable).deepEqual([]);
    should(shallow.map(tick => tick.unhealable)).deepEqual([[lost], [lost], [lost]]);
    should(shallow.map(tick => tick.missingFromIndex)).deepEqual([[], [], []]);
    should(reconciles).equal(0);
  });

  it('should ignore a terminal session with no finish stamp rather than call it a zombie', async () => {
    // Arrange
    const { storage, pass } = await fleet();
    const id = parseSessionId('undated');
    await storage.writeState(id, sessionState('undated', { status: 'failed' }));
    await storage.append(id, 'session.late_write', { note: 'no finish stamp' });

    // Act
    const actual = await pass().run(true);

    // Assert
    should(actual.zombies).deepEqual([]);
  });

  it('should not call a terminal session a zombie when its state record can no longer be read', async () => {
    // Arrange — without the finish stamp there is nothing to compare the journal's last write against.
    const { storage, pass } = await fleet();
    const id = parseSessionId('torn-state');
    await storage.writeState(id, sessionState('torn-state', { status: 'stopped', finishedAt: NOW }));
    await storage.append(id, 'session.late_write', { note: 'still working' });
    const unreadable = new StorageConsistencyPass(
      {
        listSessions: () => storage.listSessions(),
        surveySessionDirectories: async () => await storage.surveySessionDirectories(),
        sessionIdsOnDisk: async () => await storage.sessionIdsOnDisk(),
        reconcile: async () => await storage.reconcile(),
        lastEventAt: id => storage.lastEventAt(id),
        readState: async () => {
          throw new Error('the state document is torn');
        },
      },
      SETTINGS,
    );

    // Act
    const actual = await unreadable.run(true);

    // Assert
    should(actual.zombies).deepEqual([]);
    should(await pass().run(true)).not.be.undefined();
  });

  it('should not call a finished session with no journal a zombie', async () => {
    // Arrange — a session that recorded no events has no journal fingerprint to age.
    const { storage, pass } = await fleet();
    const id = parseSessionId('quiet');
    await storage.writeState(id, sessionState('quiet', { status: 'stopped', finishedAt: NOW }));

    // Act
    const actual = await pass().run(true);

    // Assert
    should(storage.findSession(id)?.journal).be.null();
    should(actual.zombies).deepEqual([]);
  });
});

describe('when a session journal last grew', () => {
  it('should be the stamp of the NEWEST of two events, not the first', async () => {
    // Arrange — two events, a minute apart by the storage's own clock.
    const { storage, at } = await fleet();
    const id = parseSessionId('two-events');
    await storage.writeState(id, sessionState('two-events'));
    at(NOW_MS);
    await storage.append(id, 'session.first', {});
    at(NOW_MS + 60_000);
    await storage.append(id, 'session.second', {});

    // Act
    const actual = storage.lastEventAt(id);

    // Assert
    should(actual).equal(new Date(NOW_MS + 60_000).toISOString());
  });
});
