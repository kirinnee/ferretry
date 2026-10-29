// The one module, not the protocol barrel: the barrel is every schema the daemon speaks, ~65 MB loaded.
import {
  classifyStallCause,
  describeDiskSaturation,
  type IoPressureView,
  ioPressureView,
} from '@ferretry/protocol/io-pressure';
import type { MillisecondClockPort } from './boot.ts';
import { type IoPressurePort, NO_IO_PRESSURE } from './io-pressure.ts';

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

/** What separates an activity's name from the activity it runs inside: `fleet refresh › runtime homes`. */
export const ACTIVITY_NESTING = ' › ';

/**
 * Which activity the code running right now belongs to, carried across every `await` inside it.
 *
 * A PORT because only a runtime can carry a value across asynchronous continuations — the composition
 * root hands in one backed by `AsyncLocalStorage`. Without one, every activity is top-level, which is
 * exactly what the ledger was before activities could nest.
 */
export interface ActivityScopePort<T> {
  current(): T | undefined;
  within<R>(value: T, work: () => R): R;
  /** Runs `work`, and everything it goes on to, in no activity at all. */
  outside<R>(work: () => R): R;
}

/** No scope at all: nothing nests. */
export const FLAT_ACTIVITY_SCOPE: ActivityScopePort<never> = Object.freeze({
  current: () => undefined,
  within: <R>(_value: never, work: () => R): R => work(),
  outside: <R>(work: () => R): R => work(),
});

interface ActivityRecord {
  /** The full label: every enclosing activity's name, outermost first, then this one's. */
  readonly label: string;
  readonly parent: ActivityRecord | undefined;
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
 *
 * WHY NESTING. Six background loops overlap almost every window on a busy daemon, so "during fleet
 * refresh, self-check, terminal reaper, analytics ingest, declared-wait watcher, turn watcher" names
 * everything and pins nothing. An activity run inside another is labelled with its whole path, and
 * {@link innermost} keeps only the deepest labels that overlapped — the step, not the loop around it.
 */
export class ActivityLedger {
  readonly #live = new Set<ActivityRecord>();
  readonly #recent: ActivityRecord[] = [];

  /**
   * @param observer Told the label and wall time of every activity as it ends — how a performance
   *   profile learns what each timer and job cost without each of them reporting it separately.
   */
  constructor(
    private readonly clock: MillisecondClockPort,
    private readonly scope: ActivityScopePort<ActivityRecord> = FLAT_ACTIVITY_SCOPE,
    private readonly observer: (label: string, wallMs: number) => void = () => undefined,
  ) {}

  /**
   * Marks `name` as running and returns the function that marks it finished. Ending twice is harmless.
   * Begun inside a {@link run}, it is labelled as nested in that activity.
   */
  begin(name: string): () => void {
    return this.#end(this.#start(name));
  }

  /** Runs `work` as the activity `name`, ending it however the work settles. Activities run inside nest. */
  async run<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    const record = this.#start(name);
    const end = this.#end(record);
    try {
      return await this.scope.within(record, work);
    } finally {
      end();
    }
  }

  #start(name: string): ActivityRecord {
    const parent = this.scope.current();
    const record: ActivityRecord = {
      label: parent === undefined ? name : `${parent.label}${ACTIVITY_NESTING}${name}`,
      parent,
      startedAtMs: this.clock.now(),
      endedAtMs: undefined,
    };
    this.#live.add(record);
    return record;
  }

  #end(record: ActivityRecord): () => void {
    return () => {
      if (!this.#live.delete(record)) return;
      record.endedAtMs = this.clock.now();
      this.observer(record.label, record.endedAtMs - record.startedAtMs);
      this.#recent.push(record);
      if (this.#recent.length > RECENT_ACTIVITY_LIMIT) this.#recent.shift();
    };
  }

  /** The label of the activity the running code belongs to, or `undefined` outside any. */
  current(): string | undefined {
    return this.scope.current()?.label;
  }

  /**
   * Runs `work` outside every activity, whatever armed it. A timer armed by one pass for the next one
   * inherits the arming pass's activity, so the next pass would be counted inside it — and the one after
   * inside that — instead of under its own name.
   */
  outside<R>(work: () => R): R {
    return this.scope.outside(work);
  }

  /** The labels running right now, oldest first, each named once. */
  inFlight(): readonly string[] {
    return labels([...this.#live]);
  }

  /** Every label that was running at any instant of `[fromMs, toMs]`, oldest first, each named once. */
  overlapping(fromMs: number, toMs: number): readonly string[] {
    return labels(this.#overlapping(fromMs, toMs));
  }

  /**
   * The deepest labels that were running at any instant of `[fromMs, toMs]`: every overlapping activity
   * that no other overlapping activity ran inside. A loop with a labelled step is named by the step.
   */
  innermost(fromMs: number, toMs: number): readonly string[] {
    const overlapping = this.#overlapping(fromMs, toMs);
    const enclosing = new Set(overlapping.map(record => record.parent));
    return labels(overlapping.filter(record => !enclosing.has(record)));
  }

  #overlapping(fromMs: number, toMs: number): ActivityRecord[] {
    return [...this.#recent, ...this.#live].filter(
      record => record.startedAtMs <= toMs && (record.endedAtMs === undefined || record.endedAtMs >= fromMs),
    );
  }
}

function labels(records: readonly ActivityRecord[]): readonly string[] {
  return [...new Set([...records].sort((a, b) => a.startedAtMs - b.startedAtMs).map(record => record.label))];
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

/** One stack frame of a sample, as the runtime's profiler reported it. */
export interface StackFrame {
  readonly name: string;
  /** The script it is in; absent for the runtime's own native frames. */
  readonly url?: string;
  readonly line?: number;
}

/** One sample of the JavaScript stack, innermost frame first. */
export interface StackSample {
  readonly frames: readonly StackFrame[];
}

/**
 * Samples of the main thread's JavaScript stack, taken by the runtime while the loop runs.
 *
 * A PORT because only the runtime can sample its own stack, and only from another thread — the loop
 * cannot look at itself while it is the thing that is stuck. `drain` hands back every sample taken since
 * the last drain and forgets them, so a meter that empties it on every tick holds exactly the samples of
 * the window between two ticks: when a tick is late, the stall's own samples.
 *
 * `discard` empties it WITHOUT turning what it held into samples. Most ticks are on time, and their
 * window's samples are thrown away; folding each into frames only to drop it was a large share of what
 * the attribution itself cost.
 */
export interface StackSamplerPort {
  drain(): readonly StackSample[];
  discard(): void;
}

/** No sampler: a stall is attributed to its labelled work alone. */
export const NO_STACK_SAMPLER: StackSamplerPort = Object.freeze({ drain: () => [], discard: () => undefined });

/** One distinct stack a stall spent its samples in, and the share of the samples it holds. */
export interface StallStack {
  /** The innermost frames, innermost first: `readFileSync ← scan (fleet/src/adapters/homes.ts:88) ← …`. */
  readonly stack: string;
  /** The share of the stall's samples in this stack, 0 to 1. */
  readonly share: number;
}

/** How many frames of a stack name it, and how many distinct stacks a stall reports. */
const STACK_DEPTH = 6;
const STACK_LIMIT = 3;

/**
 * The stacks a stall's samples spent their time in, hottest first.
 *
 * A sample is reduced to its innermost {@link STACK_DEPTH} frames, so one hot loop that is sampled at
 * many different statements still counts as one place. A path is cut to its workspace-relative part —
 * `packages/fleet/src/…` rather than an absolute checkout path or a compiled binary's virtual root.
 */
export function summariseStacks(samples: readonly StackSample[]): readonly StallStack[] {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const key = sample.frames.slice(0, STACK_DEPTH).map(describeFrame).join(' ← ');
    if (key === '') continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return [...counts]
    .sort(([, a], [, b]) => b - a)
    .slice(0, STACK_LIMIT)
    .map(([stack, count]) => ({ stack, share: Math.round((count / total) * 100) / 100 }));
}

/** One frame as a report names it: `name (daemon/src/lib/transcript/claude.ts:300)`. */
export function describeFrame(frame: StackFrame): string {
  const name = frame.name === '' ? '(anonymous)' : frame.name;
  if (frame.url === undefined || frame.url === '') return name;
  const packages = frame.url.lastIndexOf('packages/');
  const file = packages >= 0 ? frame.url.slice(packages + 'packages/'.length) : frame.url;
  return frame.line === undefined ? `${name} (${file})` : `${name} (${file}:${String(frame.line)})`;
}

/** One period during which the event loop could not run anything. */
export interface LoopStall {
  readonly atMs: number;
  readonly durationMs: number;
  /** The work that was running at some instant of the stall: the suspects, oldest first. */
  readonly during: readonly string[];
  /** The deepest of those labels — the step rather than the loop around it. */
  readonly innermost: readonly string[];
  /** Where the sampled stack spent the stall, hottest first; empty without a sampler. */
  readonly stacks: readonly StallStack[];
  /** `disk` when the disk was saturated as the stall was recorded: the loop was slow on IO, not wedged. */
  readonly cause?: 'disk';
  /** The disk's pressure as the stall was recorded, where the host reports it. */
  readonly io?: IoPressureView;
}

export interface EventLoopView {
  /** How late the most recent tick fired. */
  readonly lagMs: number;
  /** The worst lateness since this process started. */
  readonly maxLagMs: number;
  /** How many ticks were late by at least the stall threshold. */
  readonly stalls: number;
  readonly lastStall?: LoopStall;
  /** The longest stall since this process started, with what ran during it. */
  readonly worstStall?: LoopStall;
  /** The disk's pressure now, where the host reports it. */
  readonly io?: IoPressureView;
}

export interface EventLoopLagPolicy {
  /** How often the meter expects to be ticked. */
  readonly intervalMs: number;
  /** A tick at least this late is a stall, and is reported. */
  readonly stallMs: number;
}

/**
 * A tick every quarter second, and a stall at a quarter second late.
 *
 * A quarter second rather than the half second it was: the daemon's budget is no stall over 100 ms, so
 * a 300 ms block is a defect to be named, not noise — and a lower bar would name the tick's own jitter.
 */
export const DEFAULT_EVENT_LOOP_LAG_POLICY: EventLoopLagPolicy = Object.freeze({ intervalMs: 250, stallMs: 250 });

/**
 * The event loop's lateness, measured by a fixed-period tick.
 *
 * A timer cannot fire while the loop is busy, so the amount by which a tick is late IS the length of
 * the longest period the loop spent unable to run anything — no profiler needed to know that it
 * stalled. To know WHERE, a stall is attributed twice: to the innermost labelled work that overlapped
 * it, and, when the runtime samples stacks, to the stacks its samples spent their time in. The timer
 * that drives `tick` is the composition root's; this class only measures and reports.
 */
export class EventLoopLagMeter {
  #lastTickMs: number;
  #lagMs = 0;
  #maxLagMs = 0;
  #blockedMs = 0;
  #stalls = 0;
  #lastStall: LoopStall | undefined;
  #worstStall: LoopStall | undefined;

  constructor(
    private readonly clock: MillisecondClockPort,
    private readonly activities: ActivityLedger,
    private readonly policy: EventLoopLagPolicy,
    private readonly onStall: (stall: LoopStall) => void,
    private readonly sampler: StackSamplerPort = NO_STACK_SAMPLER,
    private readonly ioPressure: IoPressurePort = NO_IO_PRESSURE,
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
    this.#blockedMs += lag;
    // Emptied on EVERY tick, so the samples held when a tick is late are that window's and no other's —
    // but only a late tick's are folded into frames; an on-time window is thrown away as it stands.
    if (lag < this.policy.stallMs) {
      this.sampler.discard();
      return;
    }
    const samples = this.sampler.drain();
    const pressure = this.ioPressure.current();
    const cause = classifyStallCause(pressure);
    this.#stalls += 1;
    const stall: LoopStall = {
      atMs: now,
      durationMs: lag,
      during: this.activities.overlapping(previous, now),
      innermost: this.activities.innermost(previous, now),
      stacks: summariseStacks(samples),
      ...(cause === undefined ? {} : { cause }),
      ...(pressure === undefined ? {} : { io: ioPressureView(pressure) }),
    };
    this.#lastStall = stall;
    if (this.#worstStall === undefined || stall.durationMs > this.#worstStall.durationMs) this.#worstStall = stall;
    this.onStall(stall);
  }

  /**
   * How long, in total, the loop has been unable to run anything since this meter began — through
   * NOW, so the lateness of a tick that has not fired yet is counted too. A timer that fires late
   * because the loop was blocked may well run before the meter's own late tick does, and asking it
   * then must not miss the stall that delayed it.
   *
   * Never decreasing, so the blocked time over any window is the difference of two readings.
   */
  blockedMs(): number {
    return this.#blockedMs + Math.max(0, this.clock.now() - this.#lastTickMs - this.policy.intervalMs);
  }

  view(): EventLoopView {
    const pressure = this.ioPressure.current();
    return {
      lagMs: this.#lagMs,
      maxLagMs: this.#maxLagMs,
      stalls: this.#stalls,
      ...(this.#lastStall === undefined ? {} : { lastStall: this.#lastStall }),
      ...(this.#worstStall === undefined ? {} : { worstStall: this.#worstStall }),
      ...(pressure === undefined ? {} : { io: ioPressureView(pressure) }),
    };
  }
}

/** The line a stall writes to the boot journal: how long, what was running, and where it spent the time. */
export function describeLoopStall(stall: LoopStall): string {
  const suspects =
    stall.innermost.length === 0 ? 'no named work was in flight' : `during ${stall.innermost.join(', ')}`;
  const hottest = stall.stacks[0];
  const where = hottest === undefined ? '' : ` — ${String(Math.round(hottest.share * 100))}% in ${hottest.stack}`;
  const disk = stall.cause === undefined || stall.io === undefined ? '' : ` — ${describeDiskSaturation(stall.io)}`;
  return `event loop stalled for ${(stall.durationMs / 1_000).toFixed(1)}s — ${suspects}${where}${disk}`;
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

/**
 * Where the watchdog should measure the loop's silence from: the later of the last heartbeat and the
 * moment the process last RESUMED.
 *
 * A MAC THAT SLEEPS SUSPENDS EVERY THREAD AT ONCE. On waking, the watchdog's own check fires with a
 * heartbeat that is as old as the sleep, and a lid closed over lunch read as a loop silent for an hour —
 * so a healthy daemon was killed on every wake, and its replacement paid a whole boot for nothing. The
 * tell is the watchdog's OWN lateness: a thread that was free to run checks every `checkMs`, so a check
 * that arrives many periods after the previous one means nothing in the process ran, the loop included.
 * The silence then starts again from that check, and a loop that really is stuck is still caught one
 * limit later.
 *
 * Self-contained, because the watchdog thread embeds it by its source.
 */
export function watchdogSilenceFrom(
  beatMs: number,
  nowMs: number,
  previousCheckMs: number,
  previousFromMs: number,
  checkMs: number,
): number {
  const suspended = nowMs - previousCheckMs > Math.max(checkMs * 10, 10_000);
  const from = Math.max(beatMs, previousFromMs);
  return suspended ? Math.max(from, nowMs) : from;
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
