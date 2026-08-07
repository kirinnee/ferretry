import { describe, it } from 'bun:test';
import should from 'should';
import { KeyedSerialExecutor } from '../../../../src/adapters/system/keyed-serial-executor.ts';
import {
  firstWriteReleasedAnswerAttention,
  parseSessionId,
  type SerialExecutor,
  type SessionId,
} from '../../../../src/lib/index.ts';
import {
  defaultSessionResumeSettings,
  ResumeAcknowledgementFailed,
  ResumeCancelled,
  ResumeRefused,
  ReviveDedupeConflict,
  SessionResumeService,
  UnregisteredResumeReplacement,
  type LaunchGate,
  type PaneObservation,
  type ResumeActor,
  type ResumeAnswerAttention,
  type ResumeLauncher,
  type ResumeMonitorControl,
  type ResumeRepository,
  type ResumeTarget,
  type ResumeTransition,
  type ResumeTurnStore,
} from '../../../../src/lib/session/resume/index.ts';

/** The advisory a bare human relaunch may dismiss, and the blocking one it may never touch. */
const RELEASED = 'structured-answer-released-unconfirmed';
const UNCONFIRMED = 'structured-answer-unconfirmed';

/**
 * The composition root's own first-write advisory sentence, through the builder that owns it.
 *
 * It is the strongest identity case in the codebase for the queue fixture below: it names only the
 * TOOL, so two different request ids over one tool render this exact same string.
 */
const FIRST_WRITE_ADVISORY = firstWriteReleasedAnswerAttention('tool-1');

/** Let every already-resolved continuation run, without inventing a timer to wait on. */
const drain = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

const SETTINGS = defaultSessionResumeSettings;
const ID = parseSessionId('session-1');
const LIVE: PaneObservation = { alive: true, dead: false, promptReady: true };
const NO_PANE: PaneObservation = { alive: false, dead: false, promptReady: false };

function target(overrides: Partial<ResumeTarget> = {}): ResumeTarget {
  return { id: ID, status: 'stopped', mode: 'auto', cwd: '/workspace/project', turn: 3, ...overrides };
}

class FakeRepository implements ResumeRepository {
  readonly transitions: ResumeTransition[] = [];
  /** Refuse one named transition, to prove a second failure cannot mask the first. */
  failEvent: ResumeTransition['event'] | undefined;
  /** Observe each accepted transition, for the fixtures that assert ORDER against other work. */
  onTransition: ((change: ResumeTransition) => void) | undefined;

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
    if (change.event === this.failEvent) throw new Error(`the journal refused ${change.event}`);
    this.transitions.push(change);
    this.onTransition?.(change);
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

/**
 * The durable dismissal, recorded rather than performed.
 *
 * It shares the launcher's `calls` array in the tests that care about ORDER, because the whole
 * contract is that the acknowledgement lands after the relaunch and delivery and before the state
 * clears — and three separate spies cannot show that.
 */
class FakeAnswerAttention implements ResumeAnswerAttention {
  readonly acknowledged: ResumeActor[] = [];
  /** The transitions already journalled at the moment of the call — how "before the clear" is proved. */
  eventsWhenCalled: readonly string[] = [];
  failure: Error | undefined;

  constructor(
    private readonly trace: string[],
    private readonly events: () => readonly string[],
  ) {}

  async acknowledge(_id: SessionId, actor: ResumeActor): Promise<void> {
    this.trace.push('acknowledge');
    this.acknowledged.push(actor);
    this.eventsWhenCalled = [...this.events()];
    if (this.failure) throw this.failure;
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
  const answerAttention = new FakeAnswerAttention(launcher.calls, () => repository.events);
  const service = new SessionResumeService(
    { repository, launcher, turns, monitors, gate, serial: inlineSerial, answerAttention },
    SETTINGS,
  );
  return { service, repository, launcher, turns, monitors, gate, answerAttention };
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

  it('should fail an unregistered replacement even when the failure probe finds it alive', async () => {
    // Arrange — a live pane normally averts a false terminal, but this pane has no durable process
    // identity. Preserving it would make every reaper, attach and cgroup reader address the pane it
    // replaced instead.
    const world = build(target(), NO_PANE);
    world.launcher.relaunchError = new UnregisteredResumeReplacement(
      'replacement registration failed and teardown failed',
    );
    world.launcher.exitConfirmed = false;
    world.launcher.exitPane = { alive: true, dead: false, promptReady: true };

    // Act / Assert
    await should(world.service.resume({ id: ID, actor: 'admin-cli' })).be.rejectedWith(UnregisteredResumeReplacement);
    should(world.launcher.calls).containEql('confirmExit');
    should(world.launcher.calls).containEql('kill:failed resume cleanup');
    should(world.repository.events).containEql('session.failed');
    should(world.repository.events).not.containEql('session.resume_false_terminal_averted');
    should(world.monitors.calls).deepEqual(['stop']);
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

describe('session resume answer-advisory acknowledgement', () => {
  const advisory = (overrides: Partial<ResumeTarget> = {}): ResumeTarget =>
    target({ status: 'running', needsHumanKind: RELEASED, ...overrides });

  /** The last transition a successful revive writes; the clear rides on this one or on nothing. */
  const resumedTransition = (world: ReturnType<typeof build>): ResumeTransition | undefined =>
    world.repository.transitions.findLast(change => change.event === 'session.resumed');

  it('should release the pane, relaunch, deliver, acknowledge, and only then clear', async () => {
    // Arrange — the whole point of the ordering: a clear with no durable record behind it is a
    // warning that vanished with nothing saying a person dismissed it.
    const world = build(advisory(), LIVE);

    // Act
    const actual = await world.service.resume({ id: ID, actor: 'admin-cli' });

    // Assert
    should(actual.disposition).equal('revived');
    should(world.launcher.calls).deepEqual([
      'snapshot',
      'kill:pane cleanup before revive',
      'relaunch',
      'deliver',
      'acknowledge',
    ]);
    should(world.answerAttention.eventsWhenCalled).not.containEql('session.resumed');
    should(resumedTransition(world)).have.property('clearNeedsHuman', true);
  });

  it('should attribute the dismissal to the operator the service already authorized', async () => {
    // Arrange
    const world = build(advisory(), LIVE);

    // Act
    await world.service.resume({ id: ID, actor: 'admin-ui' });

    // Assert — attribution, not authorization: the action bit decided, this only records who.
    should(world.answerAttention.acknowledged).deepEqual(['admin-ui']);
  });

  it('should reach a bare operator relaunch on a live pane instead of refusing it as already running', async () => {
    // Arrange — the advisory is not an input modal, so this session took the send shortcut and a
    // message-free resume hit `already running`: the one action that may dismiss the warning was
    // unreachable on exactly the sessions carrying it.
    const world = build(advisory(), LIVE);

    // Act
    const actual = await world.service.resume({ id: ID, actor: 'admin-cli' });

    // Assert
    should(actual.disposition).equal('revived');
    should(world.launcher.calls).containEql('relaunch');
  });

  it('should treat a message-bearing resume as prose that neither acknowledges nor clears', async () => {
    // Arrange
    const world = build(advisory(), LIVE);

    // Act
    const actual = await world.service.resume({ id: ID, message: 'answer it in prose', actor: 'admin-cli' });

    // Assert
    should(actual.disposition).equal('sent');
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(world.repository.transitions).deepEqual([]);
  });

  it('should refuse a peer the dismissal and leave the advisory standing', async () => {
    // Arrange — `peer` is explicit but is not a person: a relaying daemon never looked at the
    // terminal, so it may not close a warning that exists to be read.
    const world = build(advisory({ status: 'stopped' }), NO_PANE);

    // Act
    const actual = await world.service.resume({ id: ID, actor: 'peer' });

    // Assert
    should(actual.disposition).equal('revived');
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(resumedTransition(world)).not.have.property('clearNeedsHuman');
  });

  it('should refuse a hand-built policy that never claimed operator standing', async () => {
    // Arrange — an absent `humanOperator` is false, so a policy written without the field cannot
    // acquire operator privileges by omission.
    const world = build(advisory({ status: 'stopped' }), NO_PANE);

    // Act
    await world.service.resume({ id: ID, policy: { automatic: false, dedupeSharedRecoveryScope: false } });

    // Assert
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(resumedTransition(world)).not.have.property('clearNeedsHuman');
  });

  it('should not let a supplied policy hand operator standing to a peer', async () => {
    // Arrange — the forgery this closes. `ResumeRequest.policy` is a real override for the fields
    // that say HOW to resume, but `humanOperator` is the capability to dismiss a warning a person is
    // meant to read. As a whole-policy override it was grantable: a peer could spell the bit itself,
    // take the bare relaunch path, and file the acknowledgement under `peer`.
    const world = build(advisory({ status: 'stopped' }), NO_PANE);

    // Act
    await world.service.resume({
      id: ID,
      actor: 'peer',
      policy: { automatic: false, dedupeSharedRecoveryScope: false, humanOperator: true },
    });

    // Assert — the resume still happens; the privilege does not.
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(resumedTransition(world)).not.have.property('clearNeedsHuman');
  });

  it('should not let an unnamed caller hand itself operator standing', async () => {
    // Arrange — omitting the actor resolves to `unknown`, the safest actor there is; a policy that
    // claims the bit anyway must not be how a caller escapes being unrecognised.
    const world = build(advisory({ status: 'stopped' }), NO_PANE);

    // Act
    await world.service.resume({
      id: ID,
      policy: { automatic: false, dedupeSharedRecoveryScope: false, humanOperator: true },
    });

    // Assert
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(resumedTransition(world)).not.have.property('clearNeedsHuman');
  });

  it('should fail closed for an operator whose supplied policy withholds the bit', async () => {
    // Arrange — narrowing works in the other direction too: the axis can be taken away by the
    // caller, so an admin resume under a policy that does not claim it dismisses nothing.
    const world = build(advisory({ status: 'stopped' }), NO_PANE);

    // Act
    await world.service.resume({
      id: ID,
      actor: 'admin-cli',
      policy: { automatic: false, dedupeSharedRecoveryScope: false, humanOperator: false },
    });

    // Assert
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(resumedTransition(world)).not.have.property('clearNeedsHuman');
  });

  it('should still dismiss when a supplied policy and the actor BOTH carry operator standing', async () => {
    // Arrange — narrowing must not become a ban: a trusted caller that states the bit AND is an
    // admin keeps the capability, or the override becomes useless to the callers that need it.
    const world = build(advisory({ status: 'stopped' }), NO_PANE);

    // Act
    await world.service.resume({
      id: ID,
      actor: 'admin-ui',
      policy: { automatic: false, dedupeSharedRecoveryScope: false, humanOperator: true },
    });

    // Assert
    should(world.answerAttention.acknowledged).deepEqual(['admin-ui']);
    should(resumedTransition(world)).have.property('clearNeedsHuman', true);
  });

  it('should pass every other supplied override through untouched', async () => {
    // Arrange — only the privilege axis is derived. A scheduled retry still pins its expected status
    // and still keeps its own retry counter, which is the whole reason the override exists.
    const world = build(target({ status: 'retrying', retryAttempt: 2, transientRetryBudget: 3 }), NO_PANE);

    // Act
    await world.service.resume({
      id: ID,
      policy: { automatic: true, dedupeSharedRecoveryScope: false, expectedStatus: 'retrying' },
    });

    // Assert — `resetRetryAttempt` false is what an automatic retry against `retrying` produces, so
    // the guard and the counter both survived the overlay.
    should(world.repository.transitions[0]).not.have.property('retryAttempt');
  });

  it('should never dismiss the blocking unconfirmed kind, even for an operator', async () => {
    // Arrange — a possibly-live form is not something a relaunch can reason about.
    const world = build(advisory({ status: 'stopped', needsHumanKind: UNCONFIRMED }), NO_PANE);

    // Act
    await world.service.resume({ id: ID, actor: 'admin-cli' });

    // Assert
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(resumedTransition(world)).not.have.property('clearNeedsHuman');
  });

  it('should not acknowledge when the old pane could not be released', async () => {
    // Arrange
    const world = build(advisory(), LIVE);
    world.launcher.cleanupFails = true;

    // Act / Assert
    await should(world.service.resume({ id: ID, actor: 'admin-cli' })).be.rejected();
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(world.repository.events).not.containEql('session.resumed');
  });

  it('should not acknowledge when the relaunch itself failed', async () => {
    // Arrange
    const world = build(advisory({ status: 'stopped' }), NO_PANE);
    world.launcher.relaunchError = new Error('tmux refused the pane');

    // Act / Assert
    await should(world.service.resume({ id: ID, actor: 'admin-cli' })).be.rejectedWith(/tmux refused the pane/u);
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(world.repository.events).containEql('session.failed');
  });

  it('should not acknowledge when the turn could not be delivered', async () => {
    // Arrange
    const world = build(advisory({ status: 'stopped' }), NO_PANE);
    world.launcher.deliverError = new Error('injection timed out');

    // Act / Assert
    await should(world.service.resume({ id: ID, actor: 'admin-cli' })).be.rejectedWith(/injection timed out/u);
    should(world.answerAttention.acknowledged).deepEqual([]);
  });

  it('should keep the advisory when a preserved harness survived a failed relaunch', async () => {
    // Arrange — a probe finding the pane alive is not a person dismissing a warning.
    const world = build(advisory({ status: 'stopped' }), NO_PANE);
    world.launcher.deliverError = new Error('injection timed out');
    world.launcher.exitConfirmed = false;
    world.launcher.exitPane = LIVE;

    // Act
    const actual = await world.service.resume({ id: ID, actor: 'admin-cli' });

    // Assert
    should(actual.disposition).equal('preserved');
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(
      world.repository.transitions.findLast(change => change.event === 'session.resume_false_terminal_averted'),
    ).not.have.property('clearNeedsHuman');
  });

  it('should keep the advisory when the replacement could not be registered', async () => {
    // Arrange
    const world = build(advisory({ status: 'stopped' }), NO_PANE);
    world.launcher.relaunchError = new UnregisteredResumeReplacement('replacement registration failed');

    // Act / Assert
    await should(world.service.resume({ id: ID, actor: 'admin-cli' })).be.rejectedWith(UnregisteredResumeReplacement);
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(world.repository.events).containEql('session.failed');
  });

  it('should keep the advisory, the live pane and its monitor when the dismissal itself throws', async () => {
    // Arrange — the revive WORKED; only the dismissal failed. Relaunching again would leave two
    // panes, and calling it a terminal failure would lie about a session that is plainly running.
    const world = build(advisory({ status: 'stopped' }), NO_PANE);
    world.answerAttention.failure = new Error('answer ledger is unwritable');

    // Act
    const failure = world.service.resume({ id: ID, actor: 'admin-cli' });

    // Assert
    await should(failure).be.rejectedWith(ResumeAcknowledgementFailed);
    await should(failure).be.rejectedWith(/answer ledger is unwritable/u);
    should(world.launcher.calls.filter(call => call === 'relaunch')).have.length(1);
    should(world.launcher.calls).not.containEql('kill:failed resume cleanup');
    should(world.repository.events).not.containEql('session.failed');
    should(resumedTransition(world)).not.have.property('clearNeedsHuman');
    // Started AFTER the lock was released, exactly as the successful path does it.
    should(world.monitors.calls).deepEqual(['stop', 'start']);
    should(world.gate.releases).equal(1);
  });

  it('should surface a failed final clear and still supervise the live replacement', async () => {
    // Arrange — the dismissal is durable and the pane is up; only the write that clears the advisory
    // failed. Reporting nothing would be a lie, relaunching would make a second pane, and leaving it
    // unsupervised is how a stalled agent goes unnoticed. The warning simply STAYS UP: projection
    // does not retire a standing released advisory on the strength of an acknowledged row — that row
    // stops it being re-minted — so a later bare-admin resume is what finishes the clear, and the
    // real journey proves that retry end to end.
    const world = build(advisory({ status: 'stopped' }), NO_PANE);
    world.repository.failEvent = 'session.resumed';

    // Act
    const failure = world.service.resume({ id: ID, actor: 'admin-cli' });

    // Assert
    await should(failure).be.rejectedWith(/the journal refused session\.resumed/u);
    should(world.answerAttention.acknowledged).deepEqual(['admin-cli']);
    should(world.launcher.calls.filter(call => call === 'relaunch')).have.length(1);
    should(world.launcher.calls).not.containEql('kill:failed resume cleanup');
    should(world.monitors.calls).deepEqual(['stop', 'start']);
    // Nothing cleared: the only transition that carries the clear is the one that was refused, so no
    // accepted transition in this attempt can have retired the advisory.
    should(world.repository.transitions.filter(change => change.clearNeedsHuman === true)).deepEqual([]);
  });

  it('should give the old pane its monitor back when the release failed and dismiss nothing', async () => {
    // Arrange — the monitor is disarmed BEFORE the pane is destroyed, so a snapshot or kill that
    // fails leaves a live pane that nothing is watching. It is also, plainly, not a dismissal.
    const world = build(advisory(), LIVE);
    world.launcher.cleanupFails = true;

    // Act
    const failure = world.service.resume({ id: ID, actor: 'admin-cli' });

    // Assert
    await should(failure).be.rejectedWith(/pane is already gone/u);
    should(world.launcher.calls).not.containEql('relaunch');
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(world.repository.events).not.containEql('session.resumed');
    should(world.monitors.calls).deepEqual(['stop', 'start']);
  });

  it('should keep reporting the dismissal failure when the state write also refuses', async () => {
    // Arrange — a second failure here used to replace the acknowledgement error, which also lost the
    // monitor: only `ResumeAcknowledgementFailed` starts one, so a live replacement was left with
    // nothing watching it.
    const world = build(advisory({ status: 'stopped' }), NO_PANE);
    world.answerAttention.failure = new Error('answer ledger is unwritable');
    world.repository.failEvent = 'session.resumed';

    // Act
    const failure = world.service.resume({ id: ID, actor: 'admin-cli' });

    // Assert
    await should(failure).be.rejectedWith(ResumeAcknowledgementFailed);
    await should(failure).be.rejectedWith(/answer ledger is unwritable/u);
    should(world.monitors.calls).deepEqual(['stop', 'start']);
    should(world.launcher.calls.filter(call => call === 'relaunch')).have.length(1);
  });

  it('should still refuse a live session holding a newer question while the advisory stands', async () => {
    // Arrange — the advisory does not license replacing a pane that is mid-conversation.
    const world = build(advisory({ pendingQuestion: { toolUseId: 'tool-2' } }), LIVE);

    // Act / Assert
    await should(world.service.resume({ id: ID, actor: 'admin-cli' })).be.rejectedWith(/answer or abandon/u);
    should(world.answerAttention.acknowledged).deepEqual([]);
    should(world.launcher.calls).deepEqual([]);
  });

  it('should hold the answer queue from the acknowledgement to the clear, so a newer advisory cannot land inside it', async () => {
    // THE RACE THIS CLOSES. The dismissal appends its record and then clears the warning, and those
    // are two awaits. If the answer queue were a different executor from resume's, a projection
    // could publish a NEWER advisory in between and the clear would erase a warning nobody had read.
    //
    // COMPARING THE MESSAGE DOES NOT FIX IT, which is why this fixture uses the strongest identity
    // case available: the composition root's first-write sentence names only the TOOL, so a second
    // request id over the same tool renders a byte-identical string. A compare-and-swap on
    // kind+message would see "the warning I acknowledged" and delete the new one. Only serializing
    // the whole interval keeps T2 out until the clear has happened.
    const serial = new KeyedSerialExecutor();
    const repository = new FakeRepository(advisory({ status: 'stopped' }));
    const launcher = new FakeLauncher(NO_PANE);
    const monitors = new FakeMonitors();
    const trace: string[] = [];
    /** The one standing warning, as the state document would hold it. */
    let standing: string | undefined = FIRST_WRITE_ADVISORY;
    repository.onTransition = change => {
      if (change.event === 'session.resumed' && change.clearNeedsHuman === true) {
        trace.push('clear');
        standing = undefined;
      }
    };
    const held = Promise.withResolvers<void>();
    const answerAttention: ResumeAnswerAttention = {
      acknowledge: async () => {
        trace.push('append');
        await held.promise;
      },
    };
    const service = new SessionResumeService(
      { repository, launcher, turns: new FakeTurns(), monitors, gate: new FakeGate(), serial, answerAttention },
      SETTINGS,
    );

    // Act — start the dismissal, let it reach the append, then queue a projection that installs a
    // byte-identical advisory for the SAME tool under a different request id.
    const dismissal = service.resume({ id: ID, actor: 'admin-cli' });
    await drain();
    should(trace).deepEqual(['append']);
    const projection = serial.run(ID, async () => {
      trace.push('T2');
      standing = FIRST_WRITE_ADVISORY;
    });
    await drain();

    // Assert — T2 is still waiting: the resume owns the key.
    should(trace).deepEqual(['append']);

    // Act — release the acknowledgement and let everything settle.
    held.resolve();
    await dismissal;
    await projection;

    // Assert — the order is append, clear, then T2, and T2's warning survives.
    should(trace).deepEqual(['append', 'clear', 'T2']);
    should(standing).equal(FIRST_WRITE_ADVISORY);
    should(monitors.calls).deepEqual(['stop', 'start']);
  });
});
