import type { ClockPort } from '../../ports.ts';

import { planWaitTick, tickOverdue, wakeSendId } from './policy.ts';
import type { SessionMonitorSettings } from './settings.ts';
import type {
  MonitorHealth,
  MonitorMonotonicClock,
  MonitorNudge,
  MonitorTickReport,
  MonitorWaits,
  ParkedSession,
  WaitHeartbeatSink,
} from './types.ts';

export interface SessionMonitorPorts {
  readonly waits: MonitorWaits;
  readonly heartbeats: WaitHeartbeatSink;
  readonly nudge: MonitorNudge;
  readonly clock: ClockPort;
  /** Wall milliseconds, for comparing against deadlines written by other processes. */
  readonly wallClock: { nowMs(): number };
  /** The gap between two ticks is a duration, so it is never read off the wall clock. */
  readonly monotonic: MonitorMonotonicClock;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The daemon's declared-wait watcher: one tick over every park this daemon holds.
 *
 * THE TICK IS THE PRODUCT. `signal waiting` was already recorded, already refused what it should
 * refuse, and already suspended the reflex layer — and nothing ever ended one. This is the half that
 * ends it: the deadline the park was accepted under is enforced, the teammate is told, and the
 * ordinary supervision it was standing down from resumes.
 *
 * FOUR ORDERINGS CARRY THE WHOLE OF IT.
 *
 * A COMPLETED TICK IS THE ONLY THING THAT ADVANCES THE LEDGER. A tick that threw leaves `lastTickAt`
 * where it was, so the next health read reports the loop as overdue by however long it has been
 * failing. The alternative — stamping the attempt — is a scheduler whose failure is indistinguishable
 * from a fleet with nothing parked, which is the bug this migration keeps finding in other clothes.
 *
 * ONE SESSION'S FAILURE NEVER ABANDONS THE REST. Each park is serviced inside its own boundary and a
 * failure is recorded against that session, because the sessions in a tick have nothing to do with
 * each other and the first unreadable record must not strand every park behind it.
 *
 * THE RECORD IS CLEARED BEFORE THE TEAMMATE IS TOLD. The wake is durable and the nudge is a keystroke
 * into a pane that may be gone; doing it the other way round would leave a session told to continue
 * while the document still says it is parked — and the next tick would tell it again.
 *
 * THE HEARTBEAT MARKS ARE PRUNED TO THE ROSTER at the end of every tick. They are the one piece of
 * in-memory state the loop keeps, and a daemon that runs for weeks would otherwise hold a mark for
 * every session that was ever parked in it.
 *
 * A REVIVE IS NOT RACED, and it is worth saying why nothing here guards against one. The nudge goes
 * through the send slice, which refuses — or waits out — a session whose launch is in flight, and a
 * relaunch registers with that same gate. The status hold is not a race either: a park stands on the
 * document until something clears it, so `waiting` is the correct status for a revived-but-still-
 * parked session, exactly as it is for any other.
 */
export class SessionMonitorService {
  /** Session id → wall milliseconds at its last published heartbeat. Per daemon, never shared. */
  private readonly beats = new Map<string, number>();
  private ticks = 0;
  private lastTickAt: string | undefined;
  /** Monotonic reading at the last COMPLETED tick, or at arming when none has completed. */
  private lastTickElapsedMs: number | undefined;
  private parked = 0;
  private consecutiveFailures = 0;
  private lastFailure: string | undefined;

  constructor(
    private readonly ports: SessionMonitorPorts,
    private readonly settings: SessionMonitorSettings,
  ) {}

  /** Marks the loop as running. Until this is called the health record says so, rather than reporting
   *  a loop that has simply never ticked as one that found nothing to do. */
  arm(): void {
    this.lastTickElapsedMs = this.ports.monotonic.elapsedMs();
  }

  disarm(): void {
    this.lastTickElapsedMs = undefined;
    this.beats.clear();
  }

  get armed(): boolean {
    return this.lastTickElapsedMs !== undefined;
  }

  async tick(): Promise<MonitorTickReport> {
    let roster: readonly ParkedSession[];
    try {
      roster = await this.ports.waits.parked();
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastFailure = message(error);
      throw error;
    }
    const nowMs = this.ports.wallClock.nowMs();
    const expired: string[] = [];
    const heartbeats: string[] = [];
    const held: string[] = [];
    const failures = new Map<string, string>();
    for (const session of roster) {
      try {
        await this.service(session, nowMs, expired, heartbeats, held);
      } catch (error) {
        failures.set(session.id, message(error));
      }
    }
    this.prune(roster);
    const elapsedMs = this.ports.monotonic.elapsedMs();
    const sinceLastTickMs = this.lastTickElapsedMs === undefined ? undefined : elapsedMs - this.lastTickElapsedMs;
    this.ticks += 1;
    this.lastTickElapsedMs = elapsedMs;
    this.lastTickAt = this.ports.clock.now();
    this.parked = roster.length;
    this.consecutiveFailures = 0;
    this.lastFailure = undefined;
    return {
      at: this.lastTickAt,
      tick: this.ticks,
      sinceLastTickMs,
      parked: roster.length,
      expired,
      heartbeats,
      held,
      failures: failures as ReadonlyMap<string, string>,
    };
  }

  /** The loop's own health, which is the answer to "was a tick missed" rather than "is anything parked". */
  health(): MonitorHealth {
    const sinceLastTickMs =
      this.lastTickElapsedMs === undefined ? 0 : this.ports.monotonic.elapsedMs() - this.lastTickElapsedMs;
    return {
      armed: this.armed,
      ticks: this.ticks,
      lastTickAt: this.lastTickAt,
      sinceLastTickMs,
      // A disarmed loop is overdue by definition: nothing is going to wake the parks it holds, and
      // reporting that as "not late yet" is the benign reading of missing evidence.
      overdue: !this.armed || tickOverdue(sinceLastTickMs, this.settings),
      parked: this.parked,
      consecutiveFailures: this.consecutiveFailures,
      lastFailure: this.lastFailure,
    };
  }

  /** Drops the heartbeat mark of every session that is no longer parked, so the map cannot grow
   *  without bound in a daemon that runs for weeks. */
  private prune(roster: readonly ParkedSession[]): void {
    const live = new Set<string>(roster.map(session => session.id));
    for (const id of this.beats.keys()) if (!live.has(id)) this.beats.delete(id);
  }

  private async service(
    session: ParkedSession,
    nowMs: number,
    expired: string[],
    heartbeats: string[],
    held: string[],
  ): Promise<void> {
    const plan = planWaitTick(session, this.beats.get(session.id), nowMs, this.settings);
    if (plan.expiry !== undefined) {
      const cleared = await this.ports.waits.expire(session.id, nowMs, plan.expiry);
      // `undefined` means the park was already gone or had been replaced by a longer one under the
      // lock. Nothing was woken, so nothing is told it was woken.
      if (cleared === undefined) return;
      this.beats.delete(session.id);
      expired.push(session.id);
      await this.ports.nudge.deliver(session.id, wakeSendId(session.id, cleared), plan.expiry.nudge);
      return;
    }
    if (plan.hold && (await this.ports.waits.hold(session.id))) held.push(session.id);
    if (plan.heartbeat === undefined) return;
    await this.ports.heartbeats.publish(session.id, plan.heartbeat);
    this.beats.set(session.id, nowMs);
    heartbeats.push(session.id);
  }
}
