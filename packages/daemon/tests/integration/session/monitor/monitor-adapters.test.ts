import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  FileWaitHeartbeat,
  KeyedSerialExecutor,
  MonitorTickRunner,
  RuntimeEnvironment,
  SendMonitorNudge,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageMonitorWaits,
  StorageSignalRepository,
  SystemClock,
} from '../../../../src/adapters/index.ts';
import {
  SessionMonitorService,
  SessionSignalService,
  defaultSessionMonitorSettings,
  parseSessionId,
  type MonitorNudge,
  type SessionId,
  type SignalArtifacts,
  type SignalRepository,
  type SignalTerminal,
  type WaitHeartbeat,
} from '../../../../src/lib/index.ts';
import type { SessionSendService } from '../../../../src/lib/session/send/service.ts';

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

async function openStorage() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-monitor-test-'));
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
  return { home, opened: await factory.open() };
}

function config(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
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
  };
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
    const { opened } = await openStorage();
    const storage = opened.storage;
    // Parked, and its status has drifted off the park — the case the roster must not filter away.
    await storage.writeConfig(ONE, config('session-1'));
    await storage.writeState(ONE, { id: 'session-1', status: 'running', waiting: { since: NOW } });
    // Not parked at all.
    await storage.writeConfig(TWO, config('session-2'));
    await storage.writeState(TWO, { id: 'session-2', status: 'running' });
    // Parked, but settled: nothing to wake, and restoring its status would resurrect a verdict.
    await storage.writeConfig(THREE, config('session-3'));
    await storage.writeState(THREE, { id: 'session-3', status: 'stopped', waiting: { since: NOW } });
    const repository = new StorageSignalRepository(storage, clock);
    const subject = new StorageMonitorWaits(storage, repository, signalsOver(repository), SETTINGS);

    // Act
    const parked = await subject.parked();

    // Assert
    should(parked.map(session => session.id)).deepEqual([ONE]);
    should(parked[0]?.status).equal('running');
    await storage.close();
  });

  it('should skip a record it could not read rather than guess at its park', async () => {
    // Arrange
    const { opened } = await openStorage();
    const storage = opened.storage;
    await storage.writeConfig(ONE, config('session-1'));
    await storage.writeState(ONE, { id: 'session-1', status: 'waiting', waiting: { since: NOW } });
    const durable = new StorageSignalRepository(storage, clock);
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
    const { opened } = await openStorage();
    const storage = opened.storage;
    const since = new Date(NOW_MS - SETTINGS.backstopMs - 1_000).toISOString();
    await storage.writeConfig(ONE, config('session-1'));
    await storage.writeState(ONE, { id: 'session-1', status: 'waiting', waiting: { since } });
    const repository = new StorageSignalRepository(storage, clock);
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
    const { opened } = await openStorage();
    const storage = opened.storage;
    await storage.writeConfig(ONE, config('session-1'));
    await storage.writeState(ONE, { id: 'session-1', status: 'waiting', waiting: { since: NOW } });
    const repository = new StorageSignalRepository(storage, clock);
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

  it('should put a drifted status back to waiting, and write nothing when it already agrees', async () => {
    // Arrange
    const { opened } = await openStorage();
    const storage = opened.storage;
    await storage.writeConfig(ONE, config('session-1'));
    await storage.writeState(ONE, { id: 'session-1', status: 'running', waiting: { since: NOW } });
    const repository = new StorageSignalRepository(storage, clock);
    const subject = new StorageMonitorWaits(storage, repository, signalsOver(repository), SETTINGS);

    // Act
    const held = await subject.hold(ONE);
    const again = await subject.hold(ONE);

    // Assert
    should(held).be.true();
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
    await new FileWaitHeartbeat(() => home).publish(ONE, beat);
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
    await new FileWaitHeartbeat(() => home).publish(ONE, {
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
    const runner = new MonitorTickRunner(service, file, SETTINGS);
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
    const runner = new MonitorTickRunner(service, file, SETTINGS);
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
    const runner = new MonitorTickRunner(service, file, SETTINGS);
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
    const runner = new MonitorTickRunner(service, blocked, SETTINGS);

    // Act & Assert
    should(await runner.run()).not.be.undefined();
    await runner.close();
  });
});
