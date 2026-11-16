import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { DiskFileSystem } from '../../../../support/daemon/disk-file-system.ts';
import {
  FileWaitHeartbeat,
  MonitorTickRunner,
  SendMonitorNudge,
  StorageMonitorWaits,
} from '../../../../../daemon/adapters/session/monitor/index.ts';
import {
  FerretSignalRepository,
  type FerretSignalHost,
} from '../../../../../daemon/adapters/session/signal/ferret-signal.ts';
import { KeyedSerialExecutor } from '../../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import {
  defaultSessionMonitorSettings,
  type MonitorNudge,
  SessionMonitorService,
  type WaitHeartbeat,
} from '../../../../../daemon/lib/session/monitor/index.ts';
import type { SessionSendService } from '../../../../../daemon/lib/session/peers/send.ts';
import { SessionSignalService } from '../../../../../daemon/lib/session/signal/service.ts';
import type {
  SignalArtifacts,
  SignalRepository,
  SignalTerminal,
} from '../../../../../daemon/lib/session/signal/types.ts';
import type { FerretId, FerretRecord, FerretWaiting } from '../../../../../contract/index.ts';
import { parseSessionId, type SessionId } from '../../../../../daemon/lib/session-id.ts';
import { memoryStorage, sessionConfig } from '../../../../support/daemon/storage.ts';

/**
 * The durable side of one monitor tick: the parks it can see, the two writes it makes to one, and the
 * record it leaves about itself.
 *
 * Everything runs against a temp `FY_HOME`. Nothing here starts a daemon, arms a real timer, binds a
 * port or addresses a tmux server.
 */

const homes = new Set<string>();
const NOW = '2026-08-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const ONE = parseSessionId('session-1');
const TWO = parseSessionId('session-2');
const THREE = parseSessionId('session-3');
const clock = { now: () => NOW };
const SETTINGS = defaultSessionMonitorSettings;

/** What the Ferrets host holds of one ferret: its state, the park it declared and the credit already given back. */
interface Held {
  state: FerretRecord['state'];
  waiting?: FerretWaiting | undefined;
  credit?: number | undefined;
}

/** A scripted Ferrets host: the ferrets it holds are the map, and the two writes a tick makes land in it. */
function ferretsOver(held: Map<string, Held>): FerretSignalHost {
  return {
    ready: async () => undefined,
    record: ferret => {
      const one = held.get(ferret);
      return one === undefined ? undefined : ({ name: 'wren', mode: 'auto', state: one.state } as FerretRecord);
    },
    resolve: reference => (held.has(reference) ? (reference as FerretId) : undefined),
    waitingOf: ferret => held.get(ferret)?.waiting,
    creditOf: async ferret => held.get(ferret)?.credit,
    saveWaiting: async (ferret, waiting, credit) => {
      const one = held.get(ferret);
      if (one !== undefined) held.set(ferret, { ...one, waiting, credit });
    },
    saveFinished: async () => refuse('a wait tick must never record a completion'),
    writeSummary: async () => refuse('a wait tick must never write a completion summary'),
    history: async () => undefined,
    stop: async () => refuse('a wait tick must never stop a pane'),
  };
}

/** The session index (the roster a tick walks) and the Ferrets host (what each park says), opened together. */
async function openStorage() {
  const { storage } = await memoryStorage({ clock });
  const held = new Map<string, Held>();
  const repository = new FerretSignalRepository(ferretsOver(held));
  return { opened: { storage }, held, repository };
}

/** One ferret in both places: the index row the roster lists and the Ferrets record the park is read from. */
async function keep(
  storage: Awaited<ReturnType<typeof memoryStorage>>['storage'],
  held: Map<string, Held>,
  id: SessionId,
  indexStatus: string,
  ferret: Held,
): Promise<void> {
  await storage.writeConfig(id, config(id));
  await storage.writeState(id, {
    id,
    turn: 1,
    status: indexStatus,
    ...(ferret.waiting === undefined ? {} : { waiting: { since: NOW } }),
  });
  held.set(id, ferret);
}

function config(id: string, overrides: Record<string, unknown> = {}) {
  return sessionConfig(id, {
    name: 'Park and wake',
    agent: '/opt/fleet/bin/claude-auto-loge',
    command: ['/opt/fleet/bin/claude-auto-loge'],
    cwd: '/workspace/project',
    mode: 'auto',
    turn: 1,
    tmuxSession: `fy-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

/** A port the tick must never reach. Throwing is the assertion: the call itself is the failure. */
function refuse(reason: string): never {
  throw new Error(reason);
}

/** The two ports `expireWait` and `holdWait` never touch, so a tick cannot reach a pane through them. */
const unusedArtifacts: SignalArtifacts = {
  writeSummary: async () => refuse('a wait tick must never write a completion summary'),
  markDone: async () => refuse('a wait tick must never write a done marker'),
  raiseQuestion: async () => refuse('a wait tick must never raise a question'),
};
const unusedTerminal: SignalTerminal = {
  snapshot: async () => refuse('a wait tick must never snapshot a pane'),
  stop: async () => refuse('a wait tick must never stop a pane'),
};

function signalsOver(repository: SignalRepository): SessionSignalService {
  return new SessionSignalService({
    repository,
    artifacts: unusedArtifacts,
    terminal: unusedTerminal,
    serial: new KeyedSerialExecutor(),
    clock,
  });
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('the parks this daemon holds', () => {
  it('should see every live park, and no session it cannot vouch for', async () => {
    // Arrange
    const { opened, held, repository } = await openStorage();
    const storage = opened.storage;
    // Parked, and its index row still says running — the case the roster must not filter away.
    await keep(storage, held, ONE, 'running', { state: 'working', waiting: { since: NOW } as FerretWaiting });
    // Not parked at all.
    await keep(storage, held, TWO, 'running', { state: 'working' });
    // Parked, but settled: nothing to wake.
    await keep(storage, held, THREE, 'stopped', { state: 'stopped', waiting: { since: NOW } as FerretWaiting });
    const subject = new StorageMonitorWaits(storage, repository, signalsOver(repository), SETTINGS);

    // Act
    const parked = await subject.parked();

    // Assert
    should(parked.map(session => session.id)).deepEqual([ONE]);
    // A ferret that declared a park reads as waiting: its status is derived from the park, so it cannot drift.
    should(parked[0]?.status).equal('waiting');
    await storage.close();
  });

  it('should not read a session the index says has ended at all', async () => {
    // Arrange — an ended session can hold no park this loop may service, so its documents are not read.
    const { opened, held, repository: durable } = await openStorage();
    const storage = opened.storage;
    await keep(storage, held, ONE, 'completed', { state: 'stopped', waiting: { since: NOW } as FerretWaiting });
    await keep(storage, held, TWO, 'waiting', { state: 'working', waiting: { since: NOW } as FerretWaiting });
    const read: SessionId[] = [];
    const counting: SignalRepository = {
      read: async (id: SessionId) => {
        read.push(id);
        return await durable.read(id);
      },
      resolvePeer: async reference => await durable.resolvePeer(reference),
      transition: async (id, change) => await durable.transition(id, change),
    };

    // Act
    const parked = await new StorageMonitorWaits(storage, counting, signalsOver(counting), SETTINGS).parked();

    // Assert
    should(parked.map(session => session.id)).deepEqual([TWO]);
    should(read).deepEqual([TWO]);
    await storage.close();
  });

  it('should skip a record it could not read rather than guess at its park', async () => {
    // Arrange
    const { opened, held, repository: durable } = await openStorage();
    const storage = opened.storage;
    await keep(storage, held, ONE, 'waiting', { state: 'working', waiting: { since: NOW } as FerretWaiting });
    const failing: SignalRepository = {
      read: async (id: SessionId) => {
        if (id === ONE) throw new Error('the state document is unreadable');
        return await durable.read(id);
      },
      resolvePeer: async reference => await durable.resolvePeer(reference),
      transition: async (id, change) => await durable.transition(id, change),
    };

    // Act
    const parked = await new StorageMonitorWaits(storage, failing, signalsOver(failing), SETTINGS).parked();

    // Assert
    should(parked).be.empty();
    await storage.close();
  });
});

describe('the two writes a tick makes to a park', () => {
  it('should end a park at its backstop, credit the time back, and journal why', async () => {
    // Arrange
    const { opened, held, repository } = await openStorage();
    const storage = opened.storage;
    const since = new Date(NOW_MS - SETTINGS.backstopMs - 1_000).toISOString();
    await keep(storage, held, ONE, 'waiting', { state: 'working', waiting: { since } as FerretWaiting });
    const subject = new StorageMonitorWaits(storage, repository, signalsOver(repository), SETTINGS);

    // Act
    const cleared = await subject.expire(ONE, NOW_MS, {
      basis: 'backstop',
      reason: 'open-ended wait hit the backstop (no condition given)',
      nudge: 'go and look',
      elapsedSeconds: 0,
    });
    const after = await repository.read(ONE);

    // Assert
    should(cleared?.since).equal(since);
    should(after?.waiting).be.undefined();
    should(after?.status).equal('running');
    // The credit is the whole point of routing this through the signal slice rather than writing the
    // document here: a park must not be charged against the turn ceiling.
    should(after?.waitingCreditSeconds).be.greaterThan(SETTINGS.backstopMs / 1_000 - 1);
    await storage.close();
  });

  it('should leave a park whose deadline has not arrived', async () => {
    // Arrange
    const { opened, held, repository } = await openStorage();
    const storage = opened.storage;
    await keep(storage, held, ONE, 'waiting', { state: 'working', waiting: { since: NOW } as FerretWaiting });
    const subject = new StorageMonitorWaits(storage, repository, signalsOver(repository), SETTINGS);

    // Act
    const cleared = await subject.expire(ONE, NOW_MS, {
      basis: 'backstop',
      reason: 'stale plan',
      nudge: 'go and look',
      elapsedSeconds: 0,
    });

    // Assert
    should(cleared).be.undefined();
    should((await repository.read(ONE))?.waiting).not.be.undefined();
    await storage.close();
  });

  it('should write nothing to hold a park, because a ferret parked already reads as waiting', async () => {
    // Arrange — a Ferrets record's status is derived from its park, so there is no drift to put back.
    const { opened, held, repository } = await openStorage();
    const storage = opened.storage;
    await keep(storage, held, ONE, 'running', { state: 'working', waiting: { since: NOW } as FerretWaiting });
    const subject = new StorageMonitorWaits(storage, repository, signalsOver(repository), SETTINGS);

    // Act
    const first = await subject.hold(ONE);
    const again = await subject.hold(ONE);

    // Assert
    should(first).be.false();
    should(again).be.false();
    should((await repository.read(ONE))?.status).equal('waiting');
    await storage.close();
  });
});

describe('the heartbeat file a park publishes', () => {
  it('should carry when the loop looked and when the park is due to be woken', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-monitor-beat-'));
    homes.add(home);
    const beat: WaitHeartbeat = {
      at: NOW,
      since: '2026-08-01T11:00:00.000Z',
      until: '2026-08-01T13:00:00.000Z',
      condition: 'the deploy',
      elapsedSeconds: 3600,
      expiresAt: '2026-08-01T13:00:00.000Z',
      remainingSeconds: 3600,
    };

    // Act
    await new FileWaitHeartbeat(() => home, new DiskFileSystem()).publish(ONE, beat);
    const written = JSON.parse(await readFile(join(home, 'checks', 'waiting.json'), 'utf8')) as Record<string, unknown>;

    // Assert
    // Both instants, because a file whose `at` is older than its own `expiresAt` is a wake that did
    // not fire — the artifact states the missed tick rather than leaving it to be inferred.
    should(written).deepEqual({
      at: NOW,
      since: '2026-08-01T11:00:00.000Z',
      elapsedSeconds: 3600,
      until: '2026-08-01T13:00:00.000Z',
      condition: 'the deploy',
      expiresAt: '2026-08-01T13:00:00.000Z',
      remainingSeconds: 3600,
    });
  });

  it('should omit what a park did not declare rather than writing it as null', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-monitor-beat-'));
    homes.add(home);

    // Act
    await new FileWaitHeartbeat(() => home, new DiskFileSystem()).publish(ONE, {
      at: NOW,
      since: NOW,
      until: undefined,
      condition: undefined,
      elapsedSeconds: 0,
      expiresAt: undefined,
      remainingSeconds: undefined,
    });
    const written = JSON.parse(await readFile(join(home, 'checks', 'waiting.json'), 'utf8')) as Record<string, unknown>;

    // Assert
    should(written).deepEqual({ at: NOW, since: NOW, elapsedSeconds: 0 });
  });
});

describe('telling a woken teammate that its wait is over', () => {
  it('should go through the send, under the key the park derives', async () => {
    // Arrange
    const sent: unknown[] = [];
    const sends = {
      send: async (request: unknown) => {
        sent.push(request);
        return undefined;
      },
    } as unknown as SessionSendService;

    // Act
    await new SendMonitorNudge(sends).deliver(ONE, `wake:${ONE}:${NOW}`, 'the wait elapsed');

    // Assert
    // No `senderReference`: the daemon is the sender, and attributing a wake to a session would end
    // that session's own park.
    should(sent).deepEqual([{ id: ONE, sendId: `wake:${ONE}:${NOW}`, message: 'the wait elapsed' }]);
  });
});

describe('the record the loop leaves about itself', () => {
  function monitorOver(waits: { parked: () => Promise<readonly never[]> }): {
    readonly service: SessionMonitorService;
  } {
    const nudge: MonitorNudge = { deliver: async () => refuse('nothing was woken') };
    return {
      service: new SessionMonitorService(
        {
          waits: {
            parked: waits.parked,
            expire: async () => undefined,
            hold: async () => false,
          },
          heartbeats: { publish: async () => undefined },
          nudge,
          questions: { reconcile: async () => new Map() },
          clock,
          wallClock: { nowMs: () => NOW_MS },
          monotonic: { elapsedMs: () => 0 },
        },
        SETTINGS,
      ),
    };
  }

  it('should publish a completed tick, and fire on the loop"s own cadence', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-monitor-record-'));
    homes.add(home);
    const file = join(home, 'monitor.json');
    const { service } = monitorOver({ parked: async () => [] });
    const runner = new MonitorTickRunner(service, file, SETTINGS, new DiskFileSystem());
    runner.arm();

    // Act
    const report = await runner.run();
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

    // Assert
    should(runner.intervalMs).equal(SETTINGS.tickIntervalMs);
    should(report?.tick).equal(1);
    should(written).have.property('armed', true);
    should(written).have.property('overdue', false);
    should(written).have.property('ticks', 1);
    should(written).have.property('lastTickAt', NOW);
    should(written).have.property('lastTick');
  });

  it('should publish the failure of a tick that could not run, rather than nothing at all', async () => {
    // A loop that only writes when it works is a loop whose failure looks like an empty fleet.
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-monitor-record-'));
    homes.add(home);
    const file = join(home, 'monitor.json');
    const { service } = monitorOver({
      parked: async () => {
        throw new Error('the session index is unreadable');
      },
    });
    const runner = new MonitorTickRunner(service, file, SETTINGS, new DiskFileSystem());
    runner.arm();

    // Act
    const report = await runner.run();
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

    // Assert
    should(report).be.undefined();
    should(written).have.property('ticks', 0);
    should(written).have.property('consecutiveFailures', 1);
    should(written).have.property('lastFailure', 'the session index is unreadable');
    should(written).not.have.property('lastTick');
  });

  it('should say the loop has stopped on shutdown, without touching closed storage', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-monitor-record-'));
    homes.add(home);
    const file = join(home, 'monitor.json');
    let rosterReads = 0;
    const { service } = monitorOver({
      parked: async () => {
        rosterReads += 1;
        return [];
      },
    });
    const runner = new MonitorTickRunner(service, file, SETTINGS, new DiskFileSystem());
    runner.arm();
    await runner.run();

    // Act
    await runner.close();
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

    // Assert
    should(rosterReads).equal(1);
    should(written).have.property('armed', false);
    should(written).have.property('overdue', true);
  });

  it('should swallow a record it cannot write, because a background timer must not fail the daemon', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-monitor-record-'));
    homes.add(home);
    const { service } = monitorOver({ parked: async () => [] });
    // A path whose parent is a FILE: the directory cannot be created, so the publish must fail.
    const blocked = join(home, 'monitor.json', 'monitor.json');
    await Bun.write(join(home, 'monitor.json'), 'not a directory');
    const runner = new MonitorTickRunner(service, blocked, SETTINGS, new DiskFileSystem());

    // Act & Assert
    should(await runner.run()).not.be.undefined();
    await runner.close();
  });
});
