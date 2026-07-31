import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId, type SerialExecutor, type SessionId } from '../../../../src/lib/index.ts';
import {
  defaultSessionResumeSettings,
  ResumeCancelled,
  ResumeRefused,
  ReviveDedupeConflict,
  SessionResumeService,
  type LaunchGate,
  type PaneObservation,
  type ResumeLauncher,
  type ResumeMonitorControl,
  type ResumeRepository,
  type ResumeTarget,
  type ResumeTransition,
  type ResumeTurnStore,
} from '../../../../src/lib/session/resume/index.ts';

const SETTINGS = defaultSessionResumeSettings;
const ID = parseSessionId('session-1');
const LIVE: PaneObservation = { alive: true, dead: false, promptReady: true };
const NO_PANE: PaneObservation = { alive: false, dead: false, promptReady: false };

function target(overrides: Partial<ResumeTarget> = {}): ResumeTarget {
  return { id: ID, status: 'stopped', mode: 'auto', cwd: '/workspace/project', turn: 3, ...overrides };
}

class FakeRepository implements ResumeRepository {
  readonly transitions: ResumeTransition[] = [];

  constructor(
    private current: ResumeTarget | undefined,
    private readonly others: readonly ResumeTarget[] = [],
  ) {}

  async read(): Promise<ResumeTarget | undefined> {
    return this.current;
  }

  async list(): Promise<readonly ResumeTarget[]> {
    return this.others;
  }

  async transition(_id: SessionId, change: ResumeTransition): Promise<ResumeTarget> {
    this.transitions.push(change);
    const base = this.current ?? target();
    this.current = {
      ...base,
      ...(change.status === undefined ? {} : { status: change.status }),
      ...(change.turn === undefined ? {} : { turn: change.turn }),
      ...(change.retryAttempt === undefined ? {} : { retryAttempt: change.retryAttempt }),
    };
    return this.current;
  }

  get events(): readonly string[] {
    return this.transitions.map(change => change.event);
  }
}

class FakeLauncher implements ResumeLauncher {
  readonly calls: string[] = [];
  readonly delivered: string[] = [];
  relaunchError: Error | undefined;
  deliverError: Error | undefined;
  exitConfirmed = true;
  exitPane: PaneObservation = { alive: false, dead: true, promptReady: false };
  confirmError: Error | undefined;

  constructor(private readonly pane: PaneObservation) {}

  async observe(): Promise<PaneObservation> {
    return this.pane;
  }

  cleanupFails = false;

  async snapshot(): Promise<void> {
    this.calls.push('snapshot');
    if (this.cleanupFails) throw new Error('pane is already gone');
  }

  async kill(_id: SessionId, reason: string): Promise<void> {
    this.calls.push(`kill:${reason}`);
    if (this.cleanupFails) throw new Error('pane is already gone');
  }

  async relaunch(): Promise<void> {
    this.calls.push('relaunch');
    if (this.relaunchError) throw this.relaunchError;
  }

  async deliver(_id: SessionId, instruction: string): Promise<void> {
    this.calls.push('deliver');
    this.delivered.push(instruction);
    if (this.deliverError) throw this.deliverError;
  }

  async confirmExit(): Promise<{ confirmed: boolean; pane: PaneObservation }> {
    this.calls.push('confirmExit');
    if (this.confirmError) throw this.confirmError;
    return { confirmed: this.exitConfirmed, pane: this.exitPane };
  }
}

class FakeTurns implements ResumeTurnStore {
  readonly written: Array<{ turn: number; document: string }> = [];
  cleared = 0;

  async writeTurn(_id: SessionId, turn: number, document: string): Promise<string> {
    this.written.push({ turn, document });
    return `/state/session-1/turns/turn-${turn}.md`;
  }

  async clearMarkers(): Promise<void> {
    this.cleared += 1;
  }
}

class FakeMonitors implements ResumeMonitorControl {
  readonly calls: string[] = [];

  async stop(): Promise<void> {
    this.calls.push('stop');
  }

  async start(): Promise<void> {
    this.calls.push('start');
  }
}

class FakeGate implements LaunchGate {
  registrations = 0;
  releases = 0;

  constructor(
    private readonly inFlight = false,
    private readonly settles = true,
  ) {}

  launching(): boolean {
    return this.inFlight;
  }

  async awaitSettled(): Promise<boolean> {
    return this.settles;
  }

  register(): { release(): void } {
    this.registrations += 1;
    return {
      release: () => {
        this.releases += 1;
      },
    };
  }
}

/** A serial executor for the unit tier: the real one is an adapter and belongs to the other ledger. */
const inlineSerial: SerialExecutor = {
  run: async (_key, work) => await work(),
  runExclusive: async work => await work(),
};

function build(
  current: ResumeTarget | undefined,
  pane: PaneObservation,
  others: readonly ResumeTarget[] = [],
  gate = new FakeGate(),
) {
  const repository = new FakeRepository(current, others);
  const launcher = new FakeLauncher(pane);
  const turns = new FakeTurns();
  const monitors = new FakeMonitors();
  const service = new SessionResumeService(
    { repository, launcher, turns, monitors, gate, serial: inlineSerial },
    SETTINGS,
  );
  return { service, repository, launcher, turns, monitors, gate };
}

describe('session resume service', () => {
  it('should revive a stopped session with a new turn and hand it to a fresh monitor', async () => {
    // Arrange
    const world = build(target(), NO_PANE);

    // Act
    const actual = await world.service.resume({ id: ID, message: 'carry on', actor: 'admin-cli' });

    // Assert
    should(actual.disposition).equal('revived');
    should(actual.target.status).equal('running');
    should(world.turns.written).deepEqual([{ turn: 4, document: `carry on\n\n${SETTINGS.turnProtocolReminder}\n` }]);
    should(world.launcher.calls).deepEqual(['relaunch', 'deliver']);
    should(world.repository.events).deepEqual(['session.resuming', 'session.resumed']);
  });

  it('should disarm the old monitor before it destroys the pane, and start a new one after unlocking', async () => {
    // Arrange — a monitor left armed observes resume's own kill and terminalizes mid-relaunch.
    const world = build(target(), LIVE);

    // Act
    await world.service.resume({ id: ID, message: 'again', actor: 'admin-cli' });

    // Assert
    should(world.monitors.calls).deepEqual(['stop', 'start']);
    should(world.launcher.calls.indexOf('snapshot')).be.greaterThan(-1);
    should(world.launcher.calls.indexOf('kill:pane cleanup before revive')).be.greaterThan(
      world.launcher.calls.indexOf('snapshot'),
    );
  });

  it('should record the discarded composer before killing a leftover pane', async () => {
    // Arrange
    const world = build(target(), LIVE);

    // Act
    await world.service.resume({ id: ID, actor: 'admin-cli' });

    // Assert
    should(world.repository.events[0]).equal('session.composer_discarded');
  });

  it('should type into a live supervised session instead of replacing it', async () => {
    // Arrange
    const world = build(target({ status: 'running' }), LIVE);

    // Act
    const actual = await world.service.resume({ id: ID, message: 'one more thing', actor: 'admin-cli' });

    // Assert
    should(actual.disposition).equal('sent');
    should(world.launcher.calls).deepEqual(['deliver']);
    should(world.launcher.delivered).deepEqual(['one more thing']);
    should(world.monitors.calls).deepEqual([]);
  });

  it('should give a bare interactive relaunch its terminal back with nothing typed', async () => {
    // Arrange
    const world = build(target({ mode: 'interactive' }), NO_PANE);

    // Act
    const actual = await world.service.resume({ id: ID, actor: 'admin-ui' });

    // Assert
    should(actual.disposition).equal('revived');
    should(world.turns.written).deepEqual([]);
    should(world.launcher.calls).deepEqual(['relaunch']);
    should(actual.target.turn).equal(3);
  });

  it('should cancel an abandoned question on the record before the relaunch clears it', async () => {
    // Arrange
    const world = build(target({ pendingQuestion: { toolUseId: 'tool-1' } }), NO_PANE);

    // Act
    await world.service.resume({ id: ID, actor: 'admin-cli' });

    // Assert
    should(world.repository.events[0]).equal('session.question_cancelled');
  });

  it('should refuse a session that does not exist', async () => {
    // Arrange
    const world = build(undefined, NO_PANE);

    // Act / Assert
    await should(world.service.resume({ id: ID, actor: 'admin-cli' })).be.rejectedWith(ResumeRefused);
  });

  it('should report a still-launching session as pending rather than failed', async () => {
    // Arrange
    const world = build(target(), NO_PANE, [], new FakeGate(true, false));

    // Act / Assert
    await should(world.service.resume({ id: ID, actor: 'admin-cli' })).be.rejectedWith(/pending, not failed/u);
  });

  it('should proceed once an in-flight first launch settles', async () => {
    // Arrange
    const world = build(target(), NO_PANE, [], new FakeGate(true, true));

    // Act
    const actual = await world.service.resume({ id: ID, actor: 'admin-cli' });

    // Assert
    should(actual.disposition).equal('revived');
  });

  it('should release its launch registration even when the resume is refused', async () => {
    // Arrange
    const gate = new FakeGate();
    const world = build(target({ status: 'kill_failed' }), NO_PANE, [], gate);

    // Act
    await should(world.service.resume({ id: ID, actor: 'admin-cli' })).be.rejected();

    // Assert
    should(gate.registrations).equal(1);
    should(gate.releases).equal(1);
  });

  it('should refuse without writing anything when the guard lost its race', async () => {
    // Arrange — the ancestor cleared human-attention state before checking this.
    const world = build(target({ status: 'running' }), NO_PANE);

    // Act
    const failure = world.service.resume({
      id: ID,
      policy: { automatic: true, dedupeSharedRecoveryScope: false, expectedStatus: 'retrying' },
    });

    // Assert
    await should(failure).be.rejectedWith(ResumeCancelled);
    should(world.repository.transitions).deepEqual([]);
    should(world.launcher.calls).deepEqual([]);
  });

  it('should suppress an automatic revive that collides with a live batch sibling', async () => {
    // Arrange
    const sibling = target({ id: parseSessionId('session-2'), label: 'my-batch', status: 'running' });
    const world = build(target({ label: 'my-batch' }), NO_PANE, [sibling]);

    // Act / Assert
    await should(world.service.resume({ id: ID, actor: 'warden' })).be.rejectedWith(ReviveDedupeConflict);
  });

  it('should preserve a harness the failure probe proves survived', async () => {
    // Arrange — a readiness error with a live prompt-ready harness is a false terminal.
    const world = build(target(), NO_PANE);
    world.launcher.deliverError = new Error('injection timed out');
    world.launcher.exitConfirmed = false;
    world.launcher.exitPane = { alive: true, dead: false, promptReady: true };

    // Act
    const actual = await world.service.resume({ id: ID, message: 'go', actor: 'admin-cli' });

    // Assert
    should(actual.disposition).equal('preserved');
    should(world.repository.events).containEql('session.resume_false_terminal_averted');
    should(world.launcher.calls).not.containEql('kill:failed resume cleanup');
    should(world.monitors.calls).deepEqual(['stop', 'start']);
  });

  it('should schedule a backed-off retry when an automatic attempt has budget left', async () => {
    // Arrange
    const world = build(target({ status: 'retrying', retryAttempt: 1, transientRetryBudget: 3 }), NO_PANE);
    world.launcher.relaunchError = new Error('tmux refused the pane');

    // Act
    const actual = await world.service.resume({
      id: ID,
      policy: { automatic: true, dedupeSharedRecoveryScope: false, expectedStatus: 'retrying' },
    });

    // Assert
    should(actual.disposition).equal('retry-scheduled');
    should(actual.retryDelayMs).equal(4_000);
    should(actual.target.retryAttempt).equal(2);
    should(world.repository.events).containEql('session.retry_scheduled');
  });

  it('should fail the session and rethrow once the retry budget is gone', async () => {
    // Arrange
    const world = build(target({ status: 'retrying', retryAttempt: 3, transientRetryBudget: 3 }), NO_PANE);
    world.launcher.relaunchError = new Error('tmux refused the pane');

    // Act
    const failure = world.service.resume({
      id: ID,
      policy: { automatic: true, dedupeSharedRecoveryScope: false, expectedStatus: 'retrying' },
    });

    // Assert
    await should(failure).be.rejectedWith(/tmux refused the pane/u);
    should(world.repository.events).containEql('session.failed');
    should(world.launcher.calls).containEql('kill:failed resume cleanup');
  });

  it('should assume nothing survived when even the failure probe fails', async () => {
    // Arrange
    const world = build(target(), NO_PANE);
    world.launcher.relaunchError = new Error('launch failed');
    world.launcher.confirmError = new Error('probe failed too');

    // Act / Assert
    await should(world.service.resume({ id: ID, actor: 'admin-cli' })).be.rejectedWith(/launch failed/u);
    should(world.repository.events).containEql('session.failed');
  });

  it('should still record the failure when the cleanup after it also fails', async () => {
    // Arrange — a pane that is already gone must not mask the launch error that got us here.
    const world = build(target(), NO_PANE);
    world.launcher.relaunchError = new Error('launch failed');
    world.launcher.cleanupFails = true;

    // Act / Assert
    await should(world.service.resume({ id: ID, actor: 'admin-cli' })).be.rejectedWith(/launch failed/u);
    should(world.repository.events).containEql('session.failed');
  });

  it('should clear stale completion markers so a previous turn cannot end the new one', async () => {
    // Arrange
    const world = build(target(), NO_PANE);

    // Act
    await world.service.resume({ id: ID, message: 'go', actor: 'admin-cli' });

    // Assert
    should(world.turns.cleared).equal(1);
  });

  it('should reset the retry counter for an operator resume and keep it for a scheduled retry', async () => {
    // Arrange
    const operator = build(target({ status: 'retrying', retryAttempt: 2, transientRetryBudget: 3 }), NO_PANE);
    const scheduled = build(target({ status: 'retrying', retryAttempt: 2, transientRetryBudget: 3 }), NO_PANE);

    // Act
    await operator.service.resume({ id: ID, actor: 'admin-cli' });
    await scheduled.service.resume({
      id: ID,
      policy: { automatic: true, dedupeSharedRecoveryScope: false, expectedStatus: 'retrying' },
    });

    // Assert
    should(operator.repository.transitions[0]).have.property('retryAttempt', 0);
    should(scheduled.repository.transitions[0]).not.have.property('retryAttempt');
  });
});
