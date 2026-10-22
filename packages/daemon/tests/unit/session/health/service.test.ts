import { describe, it } from 'bun:test';
import should from 'should';
import { AsyncActivityScope } from '../../../../src/adapters/runtime/stall-attribution.ts';
import { ActivityLedger } from '../../../../src/lib/runtime/liveness.ts';
import {
  type ConsistencyPassPort,
  type DaemonHealthSnapshot,
  defaultSessionHealthSettings,
  type ExitedSessionTransition,
  type IncoherencePass,
  type SelfCheckOutcome,
  SelfRestartCoordinator,
  type SelfRestartHandler,
  type SelfRestartStamp,
  type SelfRestartStampStore,
  type SessionExitObservation,
  type SessionHealthEvent,
  type SessionHealthPorts,
  SessionHealthService,
  type SurveyedSession,
} from '../../../../src/lib/session/health/index.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

const SETTINGS = defaultSessionHealthSettings;
const AT = '2026-07-31T10:00:00.000Z';
const NOW_MS = Date.parse(AT);

function pass(overrides: Partial<IncoherencePass> = {}): IncoherencePass {
  return { missingFromIndex: [], staleRows: [], zombies: [], repaired: [], unhealable: [], ...overrides };
}

function snapshot(overrides: Partial<DaemonHealthSnapshot> = {}): DaemonHealthSnapshot {
  return {
    sessions: [{ id: 'alive', terminal: false, monitored: true }],
    sweep: { timerArmed: true, lastSweepAt: new Date(NOW_MS - 10_000).toISOString(), intervalMs: 60_000 },
    bootstrapFinished: true,
    bootstrapErrors: [],
    supervisesMonitors: true,
    supervisesWarden: true,
    ...overrides,
  };
}

class NullStampStore implements SelfRestartStampStore {
  async read(): Promise<SelfRestartStamp | undefined> {
    return undefined;
  }

  async write(): Promise<void> {}

  async clear(): Promise<void> {}
}

class Harness {
  readonly events: SessionHealthEvent[] = [];
  readonly startedMonitors: string[] = [];
  rearms = 0;
  restarts = 0;
  elapsed = 1_000_000;
  /** Every stage the service named, in the order it ran them. */
  readonly stages: string[] = [];
  /** The walk the survey port answers with, or the error it fails with. */
  survey: readonly SurveyedSession[] | Error = [{ id: parseSessionId('alive'), journalLost: false }];
  surveys = 0;
  /** The walk each stage was handed, so a test can prove they shared one. */
  readonly handed: { readonly stage: string; readonly survey: readonly SurveyedSession[] }[] = [];
  exitObservations: readonly SessionExitObservation[] | Error = [];
  readonly settled: { readonly id: string; readonly transition: ExitedSessionTransition }[] = [];
  /** Sessions whose settle answers false (moved since), or throws when mapped to an Error. */
  readonly settleRefusals = new Map<string, false | Error>();

  constructor(
    private readonly snapshots: DaemonHealthSnapshot,
    private readonly passes: readonly (IncoherencePass | Error)[] = [pass()],
    private readonly failures: ReadonlySet<string> = new Set(),
    private readonly rearmFails = false,
    private readonly restartAnswer = true,
  ) {}

  private passIndex = 0;

  /** While set, every consistency pass waits on it: a check held in flight. */
  hold: Promise<void> | undefined;
  /** Whether each consistency pass was asked to go deep, in order. */
  readonly depths: boolean[] = [];

  readonly consistency: ConsistencyPassPort = {
    run: async (deep, survey) => {
      this.handed.push({ stage: 'consistency', survey });
      this.depths.push(deep);
      if (this.hold !== undefined) await this.hold;
      const next = this.passes[Math.min(this.passIndex, this.passes.length - 1)] ?? pass();
      this.passIndex += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };

  readonly handler: SelfRestartHandler = {
    restart: async () => {
      this.restarts += 1;
      return this.restartAnswer;
    },
  };

  ports(): SessionHealthPorts {
    return {
      inventory: { observe: async () => this.snapshots },
      survey: {
        survey: async () => {
          this.surveys += 1;
          if (this.survey instanceof Error) throw this.survey;
          return this.survey;
        },
      },
      consistency: this.consistency,
      exits: {
        observe: async survey => {
          this.handed.push({ stage: 'exits', survey });
          if (this.exitObservations instanceof Error) throw this.exitObservations;
          return this.exitObservations;
        },
        settle: async (observation, transition) => {
          const refusal = this.settleRefusals.get(observation.id);
          if (refusal instanceof Error) throw refusal;
          if (refusal === false) return false;
          this.settled.push({ id: observation.id, transition });
          return true;
        },
      },
      repair: {
        startMonitor: async id => {
          if (this.failures.has(id)) throw new Error(`tmux refused ${id}`);
          this.startedMonitors.push(id);
        },
        rearmWarden: async () => {
          this.rearms += 1;
          if (this.rearmFails) throw new Error('warden will not arm');
        },
      },
      events: {
        emit: async event => {
          this.events.push(event);
        },
      },
      clock: { now: () => AT },
      wallClock: { nowMs: () => NOW_MS },
      monotonic: { elapsedMs: () => this.elapsed },
      activities: {
        run: async (name, work) => {
          this.stages.push(name);
          return await work();
        },
      },
      restarts: new SelfRestartCoordinator(new NullStampStore(), this.handler, SETTINGS),
      version: '0.17.0',
    };
  }

  service(): SessionHealthService {
    return new SessionHealthService(this.ports(), SETTINGS);
  }
}

describe('session health service', () => {
  it('should leave a healthy fleet untouched', async () => {
    // Arrange
    const harness = new Harness(snapshot());
    const service = harness.service();

    // Act
    const actual = await service.selfCheck();

    // Assert
    should(actual.repaired).deepEqual([]);
    should(actual.wardenRearmed).be.false();
    should(actual.escalated).be.false();
    should(harness.events).deepEqual([]);
  });

  it('should name every stage of a healthy check, and no repair stage when nothing needs one', async () => {
    // Arrange
    const harness = new Harness(snapshot());

    // Act
    await harness.service().selfCheck();

    // Assert
    should(harness.stages).deepEqual(['self-check', 'inventory', 'survey', 'reconcile', 'exit observer']);
  });

  it('should name the repair stage when the check has something to repair', async () => {
    // Arrange
    const harness = new Harness(snapshot({ sweep: { timerArmed: false, intervalMs: 60_000 } }));

    // Act
    await harness.service().selfCheck();

    // Assert
    should(harness.stages).deepEqual(['self-check', 'inventory', 'survey', 'reconcile', 'exit observer', 'repair']);
  });

  it('should run as the self-check activity with every stage nested inside it', async () => {
    // Arrange — the composition root's own arrangement: one ledger, carried across awaits.
    const labels: string[] = [];
    const ledger = new ActivityLedger({ now: () => 0 }, new AsyncActivityScope(), label => labels.push(label));
    const harness = new Harness(snapshot());
    const service = new SessionHealthService({ ...harness.ports(), activities: ledger }, SETTINGS);

    // Act
    await service.selfCheck();

    // Assert — each stage is reported as it ends, and the check itself last.
    should(labels).deepEqual([
      'self-check › inventory',
      'self-check › survey',
      'self-check › reconcile',
      'self-check › exit observer',
      'self-check',
    ]);
  });

  it('should walk the session directories once a check and hand that walk to every stage', async () => {
    // Arrange
    const harness = new Harness(snapshot());
    const service = harness.service();

    // Act
    await service.selfCheck();
    await service.selfCheck();

    // Assert — one walk per check, and the same one for the consistency pass and the exit observer.
    should(harness.surveys).equal(2);
    should(harness.handed.map(handed => handed.stage)).deepEqual(['consistency', 'exits', 'consistency', 'exits']);
    for (const handed of harness.handed) should(handed.survey).equal(harness.survey);
  });

  it('should skip both stages that need a walk when the walk fails, and not count it toward a restart', async () => {
    // Arrange
    const harness = new Harness(snapshot(), [pass({ unhealable: ['ghost'] })]);
    harness.survey = new Error('the state home is unreadable');
    harness.exitObservations = [];
    const service = harness.service();

    // Act
    const actual = [await service.selfCheck(), await service.selfCheck(), await service.selfCheck()];

    // Assert
    should(harness.handed).deepEqual([]);
    should(actual.map(outcome => outcome.escalated)).deepEqual([false, false, false]);
    should(actual.map(outcome => outcome.exited)).deepEqual([[], [], []]);
    should(harness.events).deepEqual([]);
  });

  it('should restart the monitors of live sessions that lost theirs', async () => {
    // Arrange
    const harness = new Harness(
      snapshot({
        sessions: [
          { id: 'alive', terminal: false, monitored: true },
          { id: 'orphan', terminal: false, monitored: false },
        ],
      }),
    );
    const service = harness.service();
    await service.selfCheck();

    // Act
    const actual = await service.selfCheck();

    // Assert
    should(actual.repaired).deepEqual(['orphan']);
    should(harness.startedMonitors).deepEqual(['orphan', 'orphan']);
  });

  it('should keep repairing after one session refuses, rather than abandoning the rest', async () => {
    // Arrange
    const harness = new Harness(
      snapshot({
        sessions: [
          { id: 'broken', terminal: false, monitored: false },
          { id: 'orphan', terminal: false, monitored: false },
        ],
      }),
      [pass()],
      new Set(['broken']),
    );

    // Act
    const actual = await harness.service().selfCheck();

    // Assert
    should(actual.repaired).deepEqual(['orphan']);
    should(actual.failures.get('broken')).equal('tmux refused broken');
  });

  it('should re-arm a dead warden and report it', async () => {
    // Arrange
    const harness = new Harness(snapshot({ sweep: { timerArmed: false, intervalMs: 60_000 } }));

    // Act
    const actual = await harness.service().selfCheck();

    // Assert
    should(actual.wardenRearmed).be.true();
    should(harness.rearms).equal(1);
  });

  it('should report a warden that refuses to re-arm without failing the whole self-check', async () => {
    // Arrange
    const harness = new Harness(
      snapshot({ sweep: { timerArmed: false, intervalMs: 60_000 } }),
      [pass()],
      new Set(),
      true,
    );

    // Act
    const actual = await harness.service().selfCheck();

    // Assert
    should(actual.wardenRearmed).be.false();
    should(harness.rearms).equal(1);
  });

  it('should escalate to a restart only after the index resists repair for the whole streak', async () => {
    // Arrange
    const resisted = pass({ missingFromIndex: ['ghost'], unhealable: ['ghost'] });
    const harness = new Harness(snapshot(), [resisted, resisted, resisted]);
    const service = harness.service();

    // Act
    const early = [await service.selfCheck(), await service.selfCheck()];
    const escalated = await service.selfCheck();

    // Assert
    should(early.map(outcome => outcome.escalated)).deepEqual([false, false]);
    should(escalated.escalated).be.true();
    should(harness.restarts).equal(1);
    should(harness.events.map(event => event.type)).containEql('fleet.daemon_self_restart');
  });

  it('should advance the restart streak on shallow ticks that only found a lost journal', async () => {
    // Arrange — a vanished journal is reported by an ordinary tick with nothing else to say, so the
    // streak has to survive passes whose only finding is the loss itself.
    const lost = pass({ unhealable: ['lost-journal'] });
    const harness = new Harness(snapshot(), [lost, lost, lost]);
    const service = harness.service();

    // Act
    const early = [await service.selfCheck(), await service.selfCheck()];
    const escalated = await service.selfCheck();

    // Assert
    should(early.map(outcome => outcome.escalated)).deepEqual([false, false]);
    should(escalated.escalated).be.true();
  });

  it('should not advance the restart streak when the consistency pass itself could not run', async () => {
    // Arrange — an unreachable store proves nothing about the index and must not restart the daemon.
    const harness = new Harness(snapshot(), [new Error('store is locked')]);
    const service = harness.service();

    // Act
    const actual = [await service.selfCheck(), await service.selfCheck(), await service.selfCheck()];

    // Assert
    should(actual.every(outcome => !outcome.escalated)).be.true();
    should(harness.restarts).equal(0);
  });

  describe('when the timer fires while a check is still running', () => {
    /** Lets a check just started run on until it is waiting on the held consistency pass. */
    async function settle(): Promise<void> {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    /** A check held in flight until `release` is called. */
    function holding(harness: Harness): () => void {
      let release: () => void = () => undefined;
      harness.hold = new Promise<void>(resolve => {
        release = resolve;
      });
      return () => {
        harness.hold = undefined;
        release();
      };
    }

    it('should skip that tick rather than start a second check beside the first', async () => {
      // Arrange
      const harness = new Harness(snapshot());
      const service = harness.service();
      await service.tick();
      const release = holding(harness);
      harness.elapsed += SETTINGS.selfCheckIntervalMs;
      const slow = service.tick();
      await settle();
      harness.elapsed += SETTINGS.selfCheckIntervalMs;

      // Act
      const skipped = await service.tick();
      release();
      await slow;

      // Assert
      should(skipped).be.undefined();
      should(harness.depths).deepEqual([true, false]);
      should(harness.stages.filter(stage => stage === 'self-check skipped')).have.length(1);
    });

    it('should not count the skipped tick as late, so the next check reads on time', async () => {
      // Arrange — a check that takes longer than one interval, but finishes.
      const harness = new Harness(snapshot());
      const service = harness.service();
      await service.tick();
      const release = holding(harness);
      harness.elapsed += SETTINGS.selfCheckIntervalMs;
      const slow = service.tick();
      await settle();
      harness.elapsed += SETTINGS.selfCheckIntervalMs;
      await service.tick();
      release();
      await slow;
      harness.elapsed += SETTINGS.selfCheckIntervalMs;

      // Act
      const actual = await service.tick();
      const report = await service.report();

      // Assert
      should(actual?.plan.verdict).match({ freshness: 'fresh', gapMs: SETTINGS.selfCheckIntervalMs, lagMs: 0 });
      should(actual?.plan.deepPass).be.false();
      should(report.wedgeCount).equal(0);
      should(report.selfChecks).equal(3);
    });

    it('should count a check that never finishes as one wedge, however many ticks it spans', async () => {
      // Arrange
      const harness = new Harness(snapshot());
      const service = harness.service();
      await service.tick();
      const release = holding(harness);
      const stuck = service.tick();
      await settle();

      // Act — the wedge threshold passes while the check is still running, then two more ticks.
      const ticks: (SelfCheckOutcome | undefined)[] = [];
      for (const _ of [1, 2, 3]) {
        harness.elapsed += SETTINGS.wedgeGapMs / 3;
        ticks.push(await service.tick());
      }
      harness.elapsed += SETTINGS.selfCheckIntervalMs;
      ticks.push(await service.tick());
      ticks.push(await service.tick());
      const report = await service.report();
      release();
      await stuck;

      // Assert — counted once, dated from when the stuck check began, and reported unhealthy.
      should(ticks).deepEqual([undefined, undefined, undefined, undefined, undefined]);
      should(harness.events).deepEqual([
        {
          type: 'fleet.daemon_wedge',
          data: {
            gapSeconds: SETTINGS.wedgeGapMs / 1000,
            lagMs: SETTINGS.wedgeGapMs - SETTINGS.selfCheckIntervalMs,
            monitors: 1,
            since: AT,
          },
        },
      ]);
      should(report).match({ wedgeCount: 1, selfCheckFreshness: 'wedged', ok: false });
    });

    it('should owe the deep pass to the next check that runs, and only to that one', async () => {
      // Arrange
      const harness = new Harness(snapshot());
      const service = harness.service();
      await service.tick();
      const release = holding(harness);
      const stuck = service.tick();
      await settle();
      harness.elapsed += SETTINGS.wedgeGapMs;
      await service.tick();
      release();
      await stuck;

      // Act
      harness.elapsed += SETTINGS.selfCheckIntervalMs;
      const owed = await service.tick();
      harness.elapsed += SETTINGS.selfCheckIntervalMs;
      const after = await service.tick();

      // Assert — the stuck check itself went shallow; the one after it pays the deep pass.
      should(harness.depths).deepEqual([true, false, true, false]);
      should(owed?.plan.verdict.freshness).equal('fresh');
      should(after?.plan.deepPass).be.false();
      should((await service.report()).ok).be.true();
    });

    it('should leave the monitor count out of the wedge of a check stuck before it read the index', async () => {
      // Arrange
      const harness = new Harness(snapshot());
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const ports = harness.ports();
      const service = new SessionHealthService(
        {
          ...ports,
          inventory: {
            observe: async () => {
              await gate;
              return snapshot();
            },
          },
        },
        SETTINGS,
      );
      const stuck = service.tick();
      await settle();
      harness.elapsed += SETTINGS.wedgeGapMs;

      // Act
      await service.tick();
      release();
      await stuck;

      // Assert
      should(harness.events[0]).deepEqual({
        type: 'fleet.daemon_wedge',
        data: {
          gapSeconds: SETTINGS.wedgeGapMs / 1000,
          lagMs: SETTINGS.wedgeGapMs - SETTINGS.selfCheckIntervalMs,
          since: AT,
        },
      });
    });
  });

  it('should force the deep pass after a wedge and count it in the health report', async () => {
    // Arrange
    const harness = new Harness(snapshot());
    const service = harness.service();
    await service.selfCheck();
    harness.elapsed += SETTINGS.wedgeGapMs;

    // Act
    const actual = await service.selfCheck();
    const report = await service.report();

    // Assert
    should(actual.plan.deepPass).be.true();
    should(report.wedgeCount).equal(1);
    should(report.ok).be.false();
    should(harness.events[0]?.type).equal('fleet.daemon_wedge');
  });

  it('should report the ledgers it maintains rather than probing again', async () => {
    // Arrange
    const harness = new Harness(snapshot());
    const service = harness.service();

    // Act
    const before = await service.report();
    await service.selfCheck();
    const after = await service.report();

    // Assert
    should(before.selfChecks).equal(0);
    should(after.selfChecks).equal(1);
    should(after.ok).be.true();
    should(after.version).equal('0.17.0');
  });

  it('should survive an event sink that refuses every append', async () => {
    // Arrange
    const harness = new Harness(snapshot({ sweep: { timerArmed: false, intervalMs: 60_000 } }));
    const ports = harness.ports();
    const service = new SessionHealthService(
      { ...ports, events: { emit: async () => Promise.reject(new Error('journal is full')) } },
      SETTINGS,
    );

    // Act
    const actual = await service.selfCheck();

    // Assert
    should(actual.wardenRearmed).be.true();
  });

  describe('when the agent of a running session has exited', () => {
    const registration = {
      daemonId: 'daemon',
      sessionId: 'exited',
      tmuxSession: 'fy-exited',
      paneId: '%3',
      pid: 4242,
      processStartTicks: 99,
    };
    const exitedWith = (id: string, exitStatus: number | undefined, status = 'running'): SessionExitObservation => ({
      id,
      status,
      registration: { ...registration, sessionId: id },
      exit: { kind: 'exited', exitStatus },
    });

    it('should move it to a terminal status within the same tick', async () => {
      // Arrange
      const harness = new Harness(snapshot());
      harness.exitObservations = [exitedWith('exited', 3)];

      // Act
      const actual = await harness.service().selfCheck();

      // Assert
      should(actual.exited).deepEqual(['exited']);
      should(harness.settled).deepEqual([
        {
          id: 'exited',
          transition: {
            status: 'failed',
            health: 'crashed',
            reason: 'the agent exited on its own (exit status 3)',
            exitCode: 3,
          },
        },
      ]);
    });

    it('should leave a session whose status stopped claiming a live agent alone', async () => {
      // Arrange
      const harness = new Harness(snapshot());
      harness.exitObservations = [exitedWith('stopped-meanwhile', 0, 'stopped')];

      // Act
      const actual = await harness.service().selfCheck();

      // Assert
      should(actual.exited).deepEqual([]);
      should(harness.settled).deepEqual([]);
    });

    it('should keep settling the rest when one settle refuses or throws', async () => {
      // Arrange
      const harness = new Harness(snapshot());
      harness.exitObservations = [exitedWith('moved', 1), exitedWith('broken', 1), exitedWith('exited', 0)];
      harness.settleRefusals.set('moved', false);
      harness.settleRefusals.set('broken', new Error('state is unwritable'));

      // Act
      const actual = await harness.service().selfCheck();

      // Assert
      should(actual.exited).deepEqual(['exited']);
    });

    it('should finish the self-check when the exit observation itself fails', async () => {
      // Arrange
      const harness = new Harness(snapshot());
      harness.exitObservations = new Error('tmux is not installed');

      // Act
      const actual = await harness.service().selfCheck();

      // Assert
      should(actual.exited).deepEqual([]);
      should(actual.escalated).be.false();
    });
  });
});
