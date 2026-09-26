import type { ClockPort } from '../../ports.ts';
import { type ExitedSessionTransition, exitedSessionTransition, type SessionExitObservation } from './exit.ts';
import { emptyIncoherenceLedger, recordIncoherencePass } from './incoherence.ts';
import { buildDaemonHealthReport, type DaemonHealthReport } from './report.ts';
import { SelfRestartCoordinator } from './self-restart.ts';
import { planSelfCheck, type SelfCheckPlan, type WardenSweepInput } from './self-check.ts';
import type { SessionHealthSettings } from './settings.ts';
import { classifyWardenSweep } from './sweep.ts';
import type {
  IncoherenceLedger,
  IncoherencePass,
  MonotonicClockPort,
  SelfCheckLedger,
  SessionHealthEvent,
  SessionHealthObservation,
} from './types.ts';
import { emptySelfCheckLedger } from './wedge.ts';

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
 * Reconciling the disposable index against the authoritative session directories. `deep` asks it to
 * re-verify per-session state rather than only compare membership.
 */
export interface ConsistencyPassPort {
  run(deep: boolean): Promise<IncoherencePass>;
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
  /** Sessions whose status claims a live agent while their registered pane is proven dead or gone. */
  observe(): Promise<readonly SessionExitObservation[]>;
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
  readonly consistency: ConsistencyPassPort;
  readonly repair: SessionHealthRepairPort;
  readonly exits: SessionExitPort;
  readonly events: SessionHealthEventSink;
  readonly clock: ClockPort;
  /** Wall milliseconds, for ageing durable timestamps only. */
  readonly wallClock: { nowMs(): number };
  /** The gap between two ticks is a duration, so it is never read off the wall clock. */
  readonly monotonic: MonotonicClockPort;
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

  constructor(
    private readonly ports: SessionHealthPorts,
    private readonly settings: SessionHealthSettings,
  ) {}

  async selfCheck(): Promise<SelfCheckOutcome> {
    const snapshot = await this.ports.inventory.observe();
    const nowMs = this.ports.wallClock.nowMs();
    const planned = planSelfCheck(
      this.selfChecks,
      {
        tick: { elapsedMs: this.ports.monotonic.elapsedMs(), at: this.ports.clock.now() },
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
    // The consistency pass runs before repair: starting a monitor for a session the index does not
    // know about would write its observations into a row that is about to be replaced.
    const escalated = await this.reconcile(planned.plan.deepPass, nowMs);
    // After the consistency pass for the same reason repair is: a row about to be replaced is not
    // one to write a terminal status into.
    const exited = await this.settleExits();
    const repaired: string[] = [];
    const failures = new Map<string, string>();
    for (const id of planned.plan.startMonitors) {
      try {
        await this.ports.repair.startMonitor(id);
        repaired.push(id);
      } catch (error) {
        failures.set(id, message(error));
      }
    }
    const wardenRearmed = planned.plan.rearmWarden ? await this.rearmWarden() : false;
    return {
      plan: planned.plan,
      repaired,
      failures: failures as ReadonlyMap<string, string>,
      wardenRearmed,
      escalated,
      exited,
    };
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

  private async reconcile(deep: boolean, nowMs: number): Promise<boolean> {
    const pass = await this.ports.consistency.run(deep).catch(() => undefined);
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
  private async settleExits(): Promise<readonly string[]> {
    const observed = await this.ports.exits.observe().catch(() => [] as readonly SessionExitObservation[]);
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
