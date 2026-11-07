import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId, type SerialExecutor, type SessionId } from '../../../../src/lib/index.ts';
import { runningChildCount } from '../../../../src/lib/pack/admission.ts';
import { claimsRunningAgent, exitedSessionTransition } from '../../../../src/lib/session/health/exit.ts';
import type { RegisteredTerminalPane } from '../../../../src/lib/session/reap.ts';
import {
  defaultSessionResumeSettings,
  INTERRUPTED_LAUNCH_REASON,
  InterruptedLaunchReconciler,
  LAUNCH_IN_FLIGHT_STATUSES,
  type LaunchGate,
  type PaneObservation,
  type ResumableSessionStatus,
  type ResumeLauncher,
  type ResumeRepository,
  type ResumeTarget,
  type ResumeTransition,
  SessionResumeService,
} from '../../../../src/lib/session/resume/index.ts';

const NOW = '2026-10-30T08:41:01.000Z';
const STARTING = parseSessionId('mvun2vi2-e9bf27a2');
const RESUMING = parseSessionId('mvui2dl2-0427d164');
const CREATED = parseSessionId('mvui54ih-0dd1d8b7');
const RUNNING = parseSessionId('mvgt2oz9-04e28935');
const PARENT = 'mvuc7tsf-0c3d50df';

const NO_PANE: PaneObservation = { alive: false, dead: false, promptReady: false };
const DEAD_PANE: PaneObservation = { alive: true, dead: true, promptReady: false };
const LIVE_PANE: PaneObservation = { alive: true, dead: false, promptReady: true };

function target(id: SessionId, status: ResumableSessionStatus, turn = 1): ResumeTarget {
  return { id, status, mode: 'auto', cwd: '/workspace/project', turn };
}

/** A record per session that moves exactly as the storage repository moves it, including the stamp. */
class MemoryRepository implements ResumeRepository {
  readonly records = new Map<string, ResumeTarget & { reason?: string; finishedAt?: string }>();
  readonly transitions: { id: SessionId; change: ResumeTransition }[] = [];
  /** Sessions whose transition the journal refuses. */
  readonly refuse = new Set<string>();
  /** Run once, inside the next read of a session: how a concurrent writer is staged. */
  beforeRead: ((id: SessionId) => void) | undefined;

  constructor(targets: readonly ResumeTarget[]) {
    for (const each of targets) this.records.set(each.id, each);
  }

  async read(id: SessionId): Promise<ResumeTarget | undefined> {
    const hook = this.beforeRead;
    this.beforeRead = undefined;
    hook?.(id);
    return this.records.get(id);
  }

  async list(): Promise<readonly ResumeTarget[]> {
    return [...this.records.values()];
  }

  async transition(id: SessionId, change: ResumeTransition): Promise<ResumeTarget> {
    if (this.refuse.has(id)) throw new Error(`the journal refused ${change.event}`);
    this.transitions.push({ id, change });
    const base = this.records.get(id) ?? target(id, 'created');
    const next = {
      ...base,
      ...(change.status === undefined ? {} : { status: change.status }),
      ...(change.turn === undefined ? {} : { turn: change.turn }),
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...(change.finishedAt === undefined ? {} : { finishedAt: change.finishedAt }),
    };
    this.records.set(id, next);
    return next;
  }

  status(id: SessionId): string | undefined {
    return this.records.get(id)?.status;
  }
}

/** Panes as the terminal would answer, per session; an id with no entry has no pane at all. */
class FakePanes implements Pick<ResumeLauncher, 'observe'> {
  readonly panes = new Map<string, PaneObservation | Error>();

  async observe(id: SessionId): Promise<PaneObservation> {
    const pane = this.panes.get(id) ?? NO_PANE;
    if (pane instanceof Error) throw pane;
    return pane;
  }
}

class FakeGate implements LaunchGate {
  readonly inFlight = new Set<string>();

  launching(id: SessionId): boolean {
    return this.inFlight.has(id);
  }

  async awaitSettled(id: SessionId): Promise<boolean> {
    return !this.inFlight.has(id);
  }

  register(id: SessionId): { release(): void } {
    this.inFlight.add(id);
    return { release: () => this.inFlight.delete(id) };
  }
}

class RecordingLeases {
  readonly released: SessionId[] = [];
  failure: Error | undefined;

  async release(id: SessionId): Promise<void> {
    this.released.push(id);
    if (this.failure) throw this.failure;
  }
}

/** Records which keys were held, so the settle is proved to run under the session's own queue. */
class KeyRecordingSerial implements SerialExecutor {
  readonly keys: string[] = [];

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    return await work();
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return await work();
  }
}

function build(targets: readonly ResumeTarget[], options: { leases?: boolean } = {}) {
  const repository = new MemoryRepository(targets);
  const panes = new FakePanes();
  const gate = new FakeGate();
  const leases = new RecordingLeases();
  const serial = new KeyRecordingSerial();
  const reconciler = new InterruptedLaunchReconciler({
    repository,
    gate,
    panes,
    serial,
    ...(options.leases === false ? {} : { leases }),
    clock: { now: () => NOW },
  });
  return { repository, panes, gate, leases, serial, reconciler };
}

describe('the cause: nothing ever settles a launch a restart interrupted', () => {
  it('should leave created and starting out of the exit settle, so a dead pane alone never moves them', () => {
    // Arrange
    const registration = {} as RegisteredTerminalPane;
    const gone = { kind: 'gone' } as const;

    // Act
    const verdicts = [...LAUNCH_IN_FLIGHT_STATUSES].map(status =>
      exitedSessionTransition({ id: STARTING, status, registration, exit: gone }),
    );

    // Assert
    should([...LAUNCH_IN_FLIGHT_STATUSES]).deepEqual(['created', 'starting']);
    should([...LAUNCH_IN_FLIGHT_STATUSES].map(claimsRunningAgent)).deepEqual([false, false]);
    should(verdicts).deepEqual([undefined, undefined]);
  });

  it("should count such a record against its parent's Pack width for as long as it reads starting", () => {
    // Arrange
    const children = [
      { parent: PARENT, status: 'starting' },
      { parent: PARENT, status: 'starting' },
      { parent: PARENT, status: 'running' },
      { parent: PARENT, status: 'created' },
      { parent: PARENT, status: 'stopped' },
      { parent: 'someone-else', status: 'running' },
      { status: 'running' },
    ];

    // Act
    const counted = runningChildCount(PARENT, children);

    // Assert
    should(counted).equal(4);
  });
});

describe('InterruptedLaunchReconciler', () => {
  it('should record every launch nobody is performing as failed, stamped, journalled and with its lease freed', async () => {
    // Arrange
    const { repository, leases, serial, reconciler } = build([
      target(STARTING, 'starting'),
      target(CREATED, 'created', 0),
      target(RUNNING, 'running'),
    ]);

    // Act
    const outcome = await reconciler.reconcile();

    // Assert
    should(outcome).deepEqual({ failed: [STARTING, CREATED], kept: [] });
    should(repository.status(STARTING)).equal('failed');
    should(repository.status(CREATED)).equal('failed');
    should(repository.status(RUNNING)).equal('running');
    should(repository.transitions).deepEqual([
      {
        id: STARTING,
        change: {
          event: 'session.failed',
          status: 'failed',
          reason: INTERRUPTED_LAUNCH_REASON,
          finishedAt: NOW,
          data: { from: 'starting' },
        },
      },
      {
        id: CREATED,
        change: {
          event: 'session.failed',
          status: 'failed',
          reason: INTERRUPTED_LAUNCH_REASON,
          finishedAt: NOW,
          data: { from: 'created' },
        },
      },
    ]);
    should(INTERRUPTED_LAUNCH_REASON).equal('launch interrupted by a daemon restart');
    should(leases.released).deepEqual([STARTING, CREATED]);
    should(serial.keys).deepEqual([STARTING, CREATED]);
  });

  it('should settle a pane whose agent is gone, and keep one with a live agent in it', async () => {
    // Arrange
    const { repository, panes, reconciler } = build([target(STARTING, 'starting'), target(RESUMING, 'starting', 3)]);
    panes.panes.set(STARTING, DEAD_PANE);
    panes.panes.set(RESUMING, LIVE_PANE);

    // Act
    const outcome = await reconciler.reconcile();

    // Assert
    should(outcome).deepEqual({ failed: [STARTING], kept: [{ id: RESUMING, why: 'pane-alive' }] });
    should(repository.status(RESUMING)).equal('starting');
  });

  it('should keep a launch this process has in flight, and one whose pane cannot be observed', async () => {
    // Arrange
    const { repository, panes, gate, leases, reconciler } = build([
      target(STARTING, 'starting'),
      target(RESUMING, 'starting'),
    ]);
    gate.register(STARTING);
    panes.panes.set(RESUMING, new Error('tmux did not answer'));

    // Act
    const outcome = await reconciler.reconcile();

    // Assert
    should(outcome).deepEqual({
      failed: [],
      kept: [
        { id: STARTING, why: 'launching' },
        { id: RESUMING, why: 'unobservable' },
      ],
    });
    should(repository.transitions).be.empty();
    should(leases.released).be.empty();
  });

  it('should re-read under the queue and leave a session another writer moved on or removed', async () => {
    // Arrange
    const { repository, reconciler } = build([target(STARTING, 'starting'), target(RESUMING, 'starting')]);
    repository.beforeRead = id => {
      // A revive that won the race already recorded its replacement as running.
      repository.records.set(id, { ...target(id, 'running'), turn: 2 });
    };
    const removed = build([target(CREATED, 'created')]);
    removed.repository.beforeRead = id => {
      removed.repository.records.delete(id);
    };

    // Act
    const moved = await reconciler.reconcile();
    const gone = await removed.reconciler.reconcile();

    // Assert
    should(moved).deepEqual({ failed: [RESUMING], kept: [{ id: STARTING, why: 'moved' }] });
    should(gone).deepEqual({ failed: [], kept: [{ id: CREATED, why: 'moved' }] });
    should(repository.status(STARTING)).equal('running');
    should(removed.repository.transitions).be.empty();
  });

  it('should go on to the next session when one cannot be written, and say which', async () => {
    // Arrange
    const { repository, reconciler } = build([target(STARTING, 'starting'), target(CREATED, 'created')]);
    repository.refuse.add(STARTING);

    // Act
    const outcome = await reconciler.reconcile();

    // Assert
    should(outcome).deepEqual({ failed: [CREATED], kept: [{ id: STARTING, why: 'error' }] });
  });

  it('should still settle when the lease cannot be released, and when no lease store is wired', async () => {
    // Arrange
    const withLeases = build([target(STARTING, 'starting')]);
    withLeases.leases.failure = new Error('lease file is locked');
    const without = build([target(STARTING, 'starting')], { leases: false });

    // Act
    const failing = await withLeases.reconciler.reconcile();
    const unwired = await without.reconciler.reconcile();

    // Assert
    should(failing.failed).deepEqual([STARTING]);
    should(unwired.failed).deepEqual([STARTING]);
    should(without.leases.released).be.empty();
  });

  it('should free the Pack slot and let an operator resume the session into a real relaunch', async () => {
    // Arrange
    const { repository, gate, reconciler } = build([target(STARTING, 'starting', 1), target(RESUMING, 'starting', 3)]);
    const calls: string[] = [];
    const launcher: ResumeLauncher = {
      observe: async () => NO_PANE,
      snapshot: async () => {
        calls.push('snapshot');
      },
      kill: async () => {
        calls.push('kill');
      },
      relaunch: async () => {
        calls.push('relaunch');
        return undefined;
      },
      deliver: async () => {
        calls.push('deliver');
      },
      confirmExit: async () => ({ confirmed: true, pane: NO_PANE }),
    };
    const resume = new SessionResumeService(
      {
        repository,
        launcher,
        turns: { writeTurn: async (_id, turn) => `/state/turns/turn-${String(turn)}.md`, clearMarkers: async () => {} },
        monitors: { stop: async () => {}, start: async () => {} },
        gate,
        serial: { run: async (_key, work) => await work(), runExclusive: async work => await work() },
        answerAgenda: { acknowledge: async () => {} },
      },
      defaultSessionResumeSettings,
    );
    const children = () =>
      [...repository.records.values()].map(record => ({ parent: PARENT, status: record.status as string }));
    const before = runningChildCount(PARENT, children());

    // Act
    await reconciler.reconcile();
    const after = runningChildCount(PARENT, children());
    const revived = await resume.resume({ id: RESUMING, actor: 'admin-cli' });

    // Assert
    should(before).equal(2);
    should(after).equal(0);
    should(revived.disposition).equal('revived');
    should(revived.target.status).equal('running');
    should(revived.target.turn).equal(4);
    should(calls).deepEqual(['relaunch', 'deliver']);
    should(repository.transitions.map(each => each.change.event)).deepEqual([
      'session.failed',
      'session.failed',
      'session.resuming',
      'session.resumed',
    ]);
    should(gate.inFlight.size).equal(0);
  });
});
