import type { ClockPort } from '../../ports.ts';
import { type ExitedSessionTransition, exitedSessionTransition, type SessionExitObservation } from './exit.ts';
import { emptyIncoherenceLedger, recordIncoherencePass } from './incoherence.ts';
import { buildDaemonHealthReport, type DaemonHealthReport } from './report.ts';
import { planSelfCheck, type SelfCheckPlan, type WardenSweepInput } from './self-check.ts';
import type { SelfRestartCoordinator } from './self-restart.ts';
import type { SessionHealthSettings } from './settings.ts';
import { classifyWardenSweep } from './sweep.ts';
import type {
  ExitObserveOptions,
  IncoherenceLedger,
  IncoherencePass,
  LoopBlockedClockPort,
  MonotonicClockPort,
  RunningSelfCheck,
  SelfCheckActivityPort,
  SelfCheckLedger,
  SelfCheckTick,
  SessionHealthEvent,
  SessionHealthObservation,
  SurveyedSession,
} from './types.ts';
import { emptySelfCheckLedger, recordSkippedTick, wedgeEvent } from './wedge.ts';

/** Everything the self-check must be told, gathered by an adapter that knows where it all lives. */
export interface DaemonHealthSnapshot {
  readonly sessions: readonly SessionHealthObservation[];
  readonly sweep: WardenSweepInput;
  readonly bootstrapFinished: boolean;
  readonly bootstrapErrors: readonly string[];
  /** Whether this daemon runs per-session monitors at all; see `SelfCheckInput.supervisesMonitors`. */
  readonly supervisesMonitors: boolean;
  /** Whether this daemon arms a warden sweep timer. */
  readonly supervisesWarden: boolean;
}

export interface SessionHealthInventory {
  observe(): Promise<DaemonHealthSnapshot>;
}

/**
 * One walk of the session directories.
 *
 * A check takes ONE and hands it to every stage that needs to know which sessions are on disk — the
 * consistency pass and the exit observer each used to walk the whole state home for themselves, on
 * every tick, which on a large fleet behind endpoint security is most of what a tick costs.
 */
export interface SessionSurveyPort {
  survey(): Promise<readonly SurveyedSession[]>;
}

/**
 * Reconciling the disposable index against the authoritative session directories. `deep` asks it to
 * re-verify per-session state rather than only compare membership; `survey` is this check's walk of
 * the directories, so the pass compares against it rather than taking its own.
 */
export interface ConsistencyPassPort {
  run(deep: boolean, survey: readonly SurveyedSession[]): Promise<IncoherencePass>;
}

/** The two repairs a self-check is allowed to perform. Both must be safe to run on a healthy fleet. */
export interface SessionHealthRepairPort {
  startMonitor(id: string): Promise<void>;
  rearmWarden(): Promise<void>;
}

/**
 * Proving which sessions' registered panes no longer hold a running agent, and recording it.
 *
 * Read-only against tmux: an implementation lists nothing but registered panes, and neither half
 * may kill or launch anything — the whole pass must be free to run on a timer.
 */
export interface SessionExitPort {
  /**
   * Sessions whose status claims a live agent while their registered pane is proven dead or gone,
   * looked for among the sessions this check's `survey` found on disk.
   */
  observe(survey: readonly SurveyedSession[], options?: ExitObserveOptions): Promise<readonly SessionExitObservation[]>;
  /**
   * Records the transition, but only if the session still reads as it was observed. Resolves false
   * when anything moved in between — a resume that relaunched it wins, and is left alone.
   */
  settle(observation: SessionExitObservation, transition: ExitedSessionTransition): Promise<boolean>;
}

export interface SessionHealthEventSink {
  emit(event: SessionHealthEvent): Promise<void>;
}

export interface SessionHealthPorts {
  readonly inventory: SessionHealthInventory;
  readonly survey: SessionSurveyPort;
  readonly consistency: ConsistencyPassPort;
  readonly repair: SessionHealthRepairPort;
  readonly exits: SessionExitPort;
  readonly events: SessionHealthEventSink;
  readonly clock: ClockPort;
  /** Wall milliseconds, for ageing durable timestamps only. */
  readonly wallClock: { nowMs(): number };
  /** The gap between two ticks is a duration, so it is never read off the wall clock. */
  readonly monotonic: MonotonicClockPort;
  /** How long the whole event loop was blocked, so a stalled loop is not mistaken for a stuck check. */
  readonly loop: LoopBlockedClockPort;
  /** Where each stage of a check is named, so a profile can say which one the time went to. */
  readonly activities: SelfCheckActivityPort;
  readonly restarts: SelfRestartCoordinator;
  readonly version: string;
}

/** What one completed self-check did, returned so a caller can log or assert on it. */
export interface SelfCheckOutcome {
  readonly plan: SelfCheckPlan;
  /** Sessions whose monitor was successfully restarted. */
  readonly repaired: readonly string[];
  /** Sessions whose repair failed, with the reason. Failure to repair one must not stop the rest. */
  readonly failures: ReadonlyMap<string, string>;
  readonly wardenRearmed: boolean;
  readonly escalated: boolean;
  /** Sessions this check moved out of a running status because their agent had exited. */
  readonly exited: readonly string[];
}

type Repairs = Pick<SelfCheckOutcome, 'repaired' | 'failures' | 'wardenRearmed'>;

const NO_REPAIRS: Repairs = { repaired: [], failures: new Map<string, string>(), wardenRearmed: false };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the daemon's self-check: measure the tick's own lateness, reconcile the index, repair what is
 * repairable, and escalate an index that cannot be repaired.
 *
 * The service holds the two histories as instance fields — one coordinator per daemon process, no
 * module-level state — and every decision it makes lives in the pure functions it calls. What is
 * left here is ordering: verify before repairing, repair each session independently so one failure
 * cannot abandon the rest, and never escalate on anything but repair that demonstrably did not work.
 */
export class SessionHealthService {
  private selfChecks: SelfCheckLedger = emptySelfCheckLedger;
  private incoherence: IncoherenceLedger = emptyIncoherenceLedger;
  /** The check in flight, if one is: what a tick that fires before it finishes measures and skips. */
  private running: RunningSelfCheck | undefined;

  constructor(
    private readonly ports: SessionHealthPorts,
    private readonly settings: SessionHealthSettings,
  ) {}

  /**
   * One firing of the timer: a check, or — while the previous check is still running — a skip.
   *
   * Overlapping checks are never started. They would queue behind the same exclusive storage lock and
   * the same tmux server as the check they overlap, so a slow host would only pile more of the slowest
   * work onto itself. A skip resolves `undefined`; what it measured is in the ledger.
   */
  async tick(): Promise<SelfCheckOutcome | undefined> {
    const running = this.running;
    if (running === undefined) return await this.selfCheck();
    await this.ports.activities.run('self-check skipped', async () => await this.skip(running));
    return undefined;
  }

  /**
   * One check, run as the activity `self-check` with each stage named inside it, so a profile of a
   * slow check names the stage — the index read, the walk, the consistency pass, the exit observer or
   * the repairs — rather than only the check around them.
   */
  async selfCheck(): Promise<SelfCheckOutcome> {
    const since = this.reading();
    this.running = { since, counted: false };
    try {
      return await this.ports.activities.run('self-check', async () => await this.check(since));
    } finally {
      // A check that overlapped this one — only ever a direct call, never the timer — owns the record.
      if (this.running?.since === since) this.running = undefined;
    }
  }

  private async check(since: SelfCheckTick): Promise<SelfCheckOutcome> {
    const stage = this.ports.activities;
    const snapshot = await stage.run('inventory', async () => await this.ports.inventory.observe());
    if (this.running?.since === since)
      this.running = { ...this.running, monitors: snapshot.sessions.filter(session => session.monitored).length };
    const nowMs = this.ports.wallClock.nowMs();
    const planned = planSelfCheck(
      this.selfChecks,
      {
        // Read AFTER the index, never at `since`: a tick skipped while this check waited on the index
        // has moved the baseline past `since`, and a reading behind the baseline reads as a broken
        // clock — an `unknown` verdict and a needless deep pass.
        tick: this.reading(),
        nowMs,
        sessions: snapshot.sessions,
        sweep: snapshot.sweep,
        supervisesMonitors: snapshot.supervisesMonitors,
        supervisesWarden: snapshot.supervisesWarden,
        bootstrapErrors: snapshot.bootstrapErrors,
      },
      this.settings,
    );
    this.selfChecks = planned.ledger;
    for (const event of planned.plan.events) await this.emit(event);
    // ONE walk of the session directories serves the consistency pass and the exit observer. A walk
    // that failed proves nothing either would have read from it, so both are skipped exactly as if
    // each had failed its own — the next tick, at most one interval away, walks again.
    const survey = await stage.run('survey', async () => await this.ports.survey.survey().catch(() => undefined));
    // The consistency pass runs before repair: starting a monitor for a session the index does not
    // know about would write its observations into a row that is about to be replaced.
    const escalated = await stage.run(
      'reconcile',
      async () => await this.reconcile(planned.plan.deepPass, nowMs, survey),
    );
    // After the consistency pass for the same reason repair is: a row about to be replaced is not
    // one to write a terminal status into.
    const exited = await stage.run('exit observer', async () => await this.settleExits(survey));
    // Named only when there is something to repair, so a healthy tick adds no empty stage to a profile.
    const repairs =
      planned.plan.startMonitors.length === 0 && !planned.plan.rearmWarden
        ? NO_REPAIRS
        : await stage.run('repair', async () => await this.repair(planned.plan));
    return { plan: planned.plan, ...repairs, escalated, exited };
  }

  /**
   * Measures the check still running when the timer fired, and moves the gap baseline past this tick.
   * A check stuck long enough to be a wedge is counted once, here, because it cannot count itself.
   */
  private async skip(running: RunningSelfCheck): Promise<void> {
    const recorded = recordSkippedTick(this.selfChecks, { tick: this.reading(), running }, this.settings);
    this.selfChecks = recorded.ledger;
    if (recorded.verdict === undefined) return;
    if (this.running?.since === running.since) this.running = { ...this.running, counted: true };
    const event = wedgeEvent(recorded.verdict, running.monitors);
    if (event !== undefined) await this.emit(event);
  }

  /** Where the self-check timer is now: monotonic and loop-blocked readings for gaps, a wall instant to report. */
  private reading(): SelfCheckTick {
    return {
      elapsedMs: this.ports.monotonic.elapsedMs(),
      at: this.ports.clock.now(),
      loopBlockedMs: this.ports.loop.blockedMs(),
    };
  }

  /** Each repair inside its own boundary, so one session that refuses cannot abandon the rest. */
  private async repair(plan: SelfCheckPlan): Promise<Repairs> {
    const repaired: string[] = [];
    const failures = new Map<string, string>();
    for (const id of plan.startMonitors) {
      try {
        await this.ports.repair.startMonitor(id);
        repaired.push(id);
      } catch (error) {
        failures.set(id, message(error));
      }
    }
    const wardenRearmed = plan.rearmWarden ? await this.rearmWarden() : false;
    return { repaired, failures: failures as ReadonlyMap<string, string>, wardenRearmed };
  }

  /** The health surface. Reports the ledgers this service maintains, never a fresh probe. */
  async report(): Promise<DaemonHealthReport> {
    const snapshot = await this.ports.inventory.observe();
    return buildDaemonHealthReport({
      bootstrapFinished: snapshot.bootstrapFinished,
      bootstrapErrors: snapshot.bootstrapErrors,
      sessions: snapshot.sessions,
      ledger: this.selfChecks,
      sweep: classifyWardenSweep({ ...snapshot.sweep, nowMs: this.ports.wallClock.nowMs() }, this.settings),
      version: this.ports.version,
      supervisesMonitors: snapshot.supervisesMonitors,
      supervisesWarden: snapshot.supervisesWarden,
      at: this.ports.clock.now(),
    });
  }

  private async reconcile(
    deep: boolean,
    nowMs: number,
    survey: readonly SurveyedSession[] | undefined,
  ): Promise<boolean> {
    const pass =
      survey === undefined ? undefined : await this.ports.consistency.run(deep, survey).catch(() => undefined);
    // A consistency pass that could not run proves nothing about the index, so it must not advance
    // the streak that ends in a restart — an unreachable store would otherwise restart the daemon.
    if (pass === undefined) return false;
    const outcome = recordIncoherencePass(this.incoherence, pass, this.settings);
    this.incoherence = outcome.ledger;
    if (outcome.event) await this.emit(outcome.event);
    const restart = await this.ports.restarts.request(outcome.escalate, {
      consecutive: outcome.ledger.consecutive,
      unhealable: pass.unhealable,
      nowMs,
      at: this.ports.clock.now(),
    });
    if (restart.event) await this.emit(restart.event);
    return restart.outcome === 'restarting';
  }

  /**
   * Moves every session whose agent has exited out of its running status.
   *
   * Each session settles inside its own boundary, like each repair: one unwritable record must not
   * leave every other exited session reading `running`. A pass that could not observe at all is
   * simply retried by the next tick, which is at most one interval away.
   */
  /**
   * Settles ONE session whose pane was just seen to die, now rather than at the next check: the same
   * observation and the same compare-and-set the check makes, over that session alone. Answers whether
   * it settled; a pane not yet provably dead is left for the check.
   */
  async settleExitOf(id: SurveyedSession['id']): Promise<boolean> {
    const observed = await this.ports.exits
      .observe([{ id, journalLost: false }], { partial: true })
      .catch(() => [] as readonly SessionExitObservation[]);
    let settled = false;
    for (const observation of observed) {
      const transition = exitedSessionTransition(observation);
      if (transition === undefined) continue;
      if (await this.ports.exits.settle(observation, transition).catch(() => false)) settled = true;
    }
    return settled;
  }

  private async settleExits(survey: readonly SurveyedSession[] | undefined): Promise<readonly string[]> {
    if (survey === undefined) return [];
    const observed = await this.ports.exits.observe(survey).catch(() => [] as readonly SessionExitObservation[]);
    const exited: string[] = [];
    for (const observation of observed) {
      const transition = exitedSessionTransition(observation);
      if (transition === undefined) continue;
      if (await this.ports.exits.settle(observation, transition).catch(() => false)) exited.push(observation.id);
    }
    return exited;
  }

  private async rearmWarden(): Promise<boolean> {
    try {
      await this.ports.repair.rearmWarden();
      return true;
    } catch {
      // A warden that will not re-arm is reported by the next tick's sweep verdict, which stays
      // stale. Throwing here would abandon a self-check that has already repaired real sessions.
      return false;
    }
  }

  private async emit(event: SessionHealthEvent): Promise<void> {
    await this.ports.events.emit(event).catch(() => undefined);
  }
}
