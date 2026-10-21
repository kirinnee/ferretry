import type { MillisecondClockPort } from './boot.ts';

/**
 * WHETHER THIS PROCESS IS ANSWERING, AND IF NOT, WHAT IT IS DOING INSTEAD.
 *
 * `fy daemon status` on a real Mac said "process exists but its API is unavailable" for a daemon that
 * was alive the whole time, and it could not say anything else because the daemon gave it nothing to
 * read: the address was bound only after every boot step had finished — the first self-check alone took
 * seven to nine seconds over a large fleet — and once serving, a single synchronous pass over a 200 MB
 * transcript could hold the event loop for minutes (a 45-second relay liveness timer fired 366 seconds
 * late). From outside, "booting", "busy" and "wedged" were the same unanswered socket.
 *
 * Three facts close that, and they live here because every one of them is a measurement the domain can
 * own without touching a runtime:
 *
 * - {@link BootProgress} — which step a boot is on and for how long, served by `/healthz` from the
 *   moment the address is bound rather than after the last step.
 * - {@link ActivityLedger} — which named pieces of work were in flight, so a stall can be pinned on the
 *   work that was running when it happened instead of on whatever timer noticed it.
 * - {@link EventLoopLagMeter} — how late a fixed-period tick fires, which is the event loop's own
 *   account of how long it was unable to run anything, and the heartbeat the watchdog reads.
 */

/** How many finished activities a ledger remembers, so a stall can still name work that just ended. */
const RECENT_ACTIVITY_LIMIT = 64;

interface ActivityRecord {
  readonly name: string;
  readonly startedAtMs: number;
  endedAtMs: number | undefined;
}

/**
 * The named work this process has in flight.
 *
 * WHY "OVERLAPPING" RATHER THAN "IN FLIGHT". A synchronous pass blocks the loop, then returns, and its
 * promise settles in the microtasks that run BEFORE the late timer that measures the stall gets to fire.
 * Asking only what is in flight at detection time would therefore miss exactly the culprit — it has
 * already ended. The ledger keeps the recently finished ones too, and the meter asks for everything that
 * was running at any instant of the window the loop was stalled for.
 */
export class ActivityLedger {
  readonly #live = new Set<ActivityRecord>();
  readonly #recent: ActivityRecord[] = [];

  constructor(private readonly clock: MillisecondClockPort) {}

  /** Marks `name` as running and returns the function that marks it finished. Ending twice is harmless. */
  begin(name: string): () => void {
    const record: ActivityRecord = { name, startedAtMs: this.clock.now(), endedAtMs: undefined };
    this.#live.add(record);
    return () => {
      if (!this.#live.delete(record)) return;
      record.endedAtMs = this.clock.now();
      this.#recent.push(record);
      if (this.#recent.length > RECENT_ACTIVITY_LIMIT) this.#recent.shift();
    };
  }

  /** Runs `work` as the activity `name`, ending it however the work settles. */
  async run<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    const end = this.begin(name);
    try {
      return await work();
    } finally {
      end();
    }
  }

  /** The names running right now, oldest first, each named once. */
  inFlight(): readonly string[] {
    return distinct([...this.#live].sort((a, b) => a.startedAtMs - b.startedAtMs).map(record => record.name));
  }

  /** Every name that was running at any instant of `[fromMs, toMs]`, oldest first, each named once. */
  overlapping(fromMs: number, toMs: number): readonly string[] {
    return distinct(
      [...this.#recent, ...this.#live]
        .filter(record => record.startedAtMs <= toMs && (record.endedAtMs === undefined || record.endedAtMs >= fromMs))
        .sort((a, b) => a.startedAtMs - b.startedAtMs)
        .map(record => record.name),
    );
  }
}

function distinct(names: readonly string[]): readonly string[] {
  return [...new Set(names)];
}

/**
 * Where a boot is.
 *
 * - `starting` — the address is bound and answers liveness, but no route beyond it is mounted yet.
 * - `finishing` — every route is served; boot work that does not gate serving is still running.
 * - `ready` — the boot has finished.
 */
export type BootPhase = 'starting' | 'finishing' | 'ready';

export interface BootSnapshot {
  readonly phase: BootPhase;
  /** The step in progress, or the last one entered once the boot is ready. */
  readonly step: string;
  readonly stepElapsedMs: number;
  readonly bootElapsedMs: number;
}

/**
 * The boot's own account of which step it is on.
 *
 * A step is ENTERED before its work starts, unlike the boot journal's milestones, which are written
 * after one finishes. A boot that never leaves a step is then reported as being on that step — "starting:
 * first self-check, 4 minutes" — rather than as the milestone before it, which is what the log alone
 * would say and is the wrong place to look.
 *
 * Every step is also an activity in the ledger, so an event-loop stall during boot names the step.
 */
export class BootProgress {
  #phase: BootPhase = 'starting';
  #step = 'starting';
  #stepStartedAtMs: number;
  #endStep: () => void;

  constructor(
    private readonly clock: MillisecondClockPort,
    private readonly activities: ActivityLedger,
    readonly startedAtMs: number = clock.now(),
  ) {
    this.#stepStartedAtMs = startedAtMs;
    this.#endStep = activities.begin(`boot: ${this.#step}`);
  }

  /** Starts `step`, ending the one before it. */
  enter(step: string): void {
    this.#endStep();
    this.#step = step;
    this.#stepStartedAtMs = this.clock.now();
    this.#endStep = this.activities.begin(`boot: ${step}`);
  }

  /** Every route is now served. */
  serving(): void {
    if (this.#phase === 'starting') this.#phase = 'finishing';
  }

  /** The boot has finished. */
  finish(): void {
    this.#endStep();
    this.#phase = 'ready';
  }

  get finished(): boolean {
    return this.#phase === 'ready';
  }

  snapshot(): BootSnapshot {
    const now = this.clock.now();
    return {
      phase: this.#phase,
      step: this.#step,
      stepElapsedMs: Math.max(0, now - this.#stepStartedAtMs),
      bootElapsedMs: Math.max(0, now - this.startedAtMs),
    };
  }
}

/** One period during which the event loop could not run anything. */
export interface LoopStall {
  readonly atMs: number;
  readonly durationMs: number;
  /** The work that was running at some instant of the stall: the suspects, oldest first. */
  readonly during: readonly string[];
}

export interface EventLoopView {
  /** How late the most recent tick fired. */
  readonly lagMs: number;
  /** The worst lateness since this process started. */
  readonly maxLagMs: number;
  /** How many ticks were late by at least the stall threshold. */
  readonly stalls: number;
  readonly lastStall?: LoopStall;
}

export interface EventLoopLagPolicy {
  /** How often the meter expects to be ticked. */
  readonly intervalMs: number;
  /** A tick at least this late is a stall, and is reported. */
  readonly stallMs: number;
}

/** A tick every quarter second, and a stall at half a second late — short enough to name a culprit. */
export const DEFAULT_EVENT_LOOP_LAG_POLICY: EventLoopLagPolicy = Object.freeze({ intervalMs: 250, stallMs: 500 });

/**
 * The event loop's lateness, measured by a fixed-period tick.
 *
 * A timer cannot fire while the loop is busy, so the amount by which a tick is late IS the length of
 * the longest period the loop spent unable to run anything — no sampling, no profiler. The timer that
 * drives `tick` is the composition root's; this class only measures and reports.
 */
export class EventLoopLagMeter {
  #lastTickMs: number;
  #lagMs = 0;
  #maxLagMs = 0;
  #stalls = 0;
  #lastStall: LoopStall | undefined;

  constructor(
    private readonly clock: MillisecondClockPort,
    private readonly activities: ActivityLedger,
    private readonly policy: EventLoopLagPolicy,
    private readonly onStall: (stall: LoopStall) => void,
  ) {
    this.#lastTickMs = clock.now();
  }

  /** One tick of the timer. */
  tick(): void {
    const now = this.clock.now();
    const lag = Math.max(0, now - this.#lastTickMs - this.policy.intervalMs);
    const previous = this.#lastTickMs;
    this.#lastTickMs = now;
    this.#lagMs = lag;
    this.#maxLagMs = Math.max(this.#maxLagMs, lag);
    if (lag < this.policy.stallMs) return;
    this.#stalls += 1;
    this.#lastStall = { atMs: now, durationMs: lag, during: this.activities.overlapping(previous, now) };
    this.onStall(this.#lastStall);
  }

  view(): EventLoopView {
    return {
      lagMs: this.#lagMs,
      maxLagMs: this.#maxLagMs,
      stalls: this.#stalls,
      ...(this.#lastStall === undefined ? {} : { lastStall: this.#lastStall }),
    };
  }
}

/** The line a stall writes to the boot journal: how long, and what was running. */
export function describeLoopStall(stall: LoopStall): string {
  const suspects = stall.during.length === 0 ? 'no named work was in flight' : `during ${stall.during.join(', ')}`;
  return `event loop stalled for ${(stall.durationMs / 1_000).toFixed(1)}s — ${suspects}`;
}

/**
 * The watchdog's verdict on a heartbeat it last saw `silentMs` ago.
 *
 * A PROCESS WHOSE EVENT LOOP HAS STOPPED CANNOT BE ASKED TO STOP. It answers no request, runs no timer
 * and handles no SIGTERM, so a service manager that believes it is running leaves it there forever —
 * holding the state home's lock, which also keeps every replacement from starting. The watchdog runs on
 * its own thread, sees the heartbeat go quiet, and ends the process so the manager can start a fresh one.
 */
export function watchdogShouldFire(silentMs: number, limitMs: number): boolean {
  return limitMs > 0 && silentMs >= limitMs;
}

/** What the watchdog says just before it ends the daemon. */
export function describeWatchdogFire(silentMs: number, during: string): string {
  const suspects = during === '' ? 'no named work was in flight' : `during ${during}`;
  return `watchdog: the event loop has not run for ${(silentMs / 1_000).toFixed(0)}s (${suspects}) — ending this process so its service manager starts a fresh one`;
}

/** The port the composition root's watchdog thread is driven through. */
export interface LoopWatchdogPort {
  /** The loop ran just now; `during` names the work in flight, for the line the watchdog writes. */
  beat(during: readonly string[]): void;
  stop(): void;
}

/** A watchdog that watches nothing, for a daemon run with the watchdog switched off. */
export const NO_WATCHDOG: LoopWatchdogPort = Object.freeze({ beat: () => undefined, stop: () => undefined });

/** The variable that sets how long the loop may be silent before the watchdog ends the daemon. */
export const WATCHDOG_VARIABLE = 'FYD_WATCHDOG_SECONDS';

/**
 * Five minutes. Long enough that no legitimate piece of work reaches it — the relay already gives up on
 * a socket after 45 seconds of silence, so a loop silent this long is serving nobody — and short enough
 * that a wedged daemon is replaced the same coffee break rather than sitting until someone notices.
 */
export const DEFAULT_WATCHDOG_LIMIT_MS = 300_000;

/**
 * The watchdog limit for this `FYD_WATCHDOG_SECONDS` value: absent or empty is the default, `0` switches
 * the watchdog off (for a person attaching a debugger, who expects the loop to stop), and anything that
 * is not a whole number of seconds throws, naming the variable, so a typo is heard at boot.
 */
export function parseWatchdogLimit(raw: string | undefined): number {
  const text = raw?.trim() ?? '';
  if (text === '') return DEFAULT_WATCHDOG_LIMIT_MS;
  if (!/^\d+$/u.test(text)) throw new Error(`${WATCHDOG_VARIABLE} must be a whole number of seconds: ${text}`);
  return Number(text) * 1_000;
}
