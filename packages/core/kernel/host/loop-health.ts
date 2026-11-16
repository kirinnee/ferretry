import { type Instant, instantFromEpochMs } from '@ferretry/std';

/**
 * WHETHER THIS PROCESS IS ANSWERING, AND IF NOT, WHY: the event loop's own account of its lateness, the disk's pressure
 * as Linux reports it, and the verdict a watchdog thread makes when the loop has gone quiet. Pure: the clock is passed
 * in, the timer that drives {@link LoopMeter.tick} and the thread behind the watchdog are the host's adapters'.
 */

// ── io pressure ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One PSI line: the share of the last 10, 60 and 300 seconds spent stalled, each 0 to 100. */
interface IoPressureLine {
  readonly avg10: number;
  readonly avg60: number;
  readonly avg300: number;
}

/** One reading of `/proc/pressure/io`: `some` (a task waited on IO) and, on kernels that report it, `full` (all did). */
export interface IoPressure {
  readonly some: IoPressureLine;
  readonly full?: IoPressureLine;
}

/** What `/healthz` says of a reading: the last-10-second shares and the verdict, never the raw windows. */
export interface IoPressureView {
  readonly someAvg10: number;
  readonly fullAvg10?: number;
  readonly saturated: boolean;
}

/** The `full` share of the last ten seconds at which the disk is called saturated. */
const SATURATED_FULL_AVG10 = 10;
/** The `some` share of the last ten seconds at which it is, for kernels that report `some` alone. */
const SATURATED_SOME_AVG10 = 25;

const PSI_LINE = /^(some|full)((?:\s+(?:avg10|avg60|avg300|total)=[0-9.]+)+)\s*$/u;

function lineOf(fields: string): IoPressureLine | undefined {
  const values = new Map<string, number>();
  for (const field of fields.trim().split(/\s+/u)) {
    const [name = '', value = ''] = field.split('=');
    values.set(name, Number(value));
  }
  const [avg10, avg60, avg300] = ['avg10', 'avg60', 'avg300'].map(name => values.get(name) ?? Number.NaN);
  const usable = [avg10, avg60, avg300].every(
    value => value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100,
  );
  return usable ? { avg10: avg10 as number, avg60: avg60 as number, avg300: avg300 as number } : undefined;
}

/** The reading in `/proc/pressure/io`'s text, or `undefined` when it holds no usable `some` line. Never throws. */
export function parseIoPressure(text: string): IoPressure | undefined {
  let some: IoPressureLine | undefined;
  let full: IoPressureLine | undefined;
  for (const raw of text.split('\n')) {
    const match = PSI_LINE.exec(raw.trim());
    if (match === null) continue;
    const line = lineOf(match[2] ?? '');
    if (match[1] === 'some') some = line;
    else full = line;
  }
  if (some === undefined) return undefined;
  return full === undefined ? { some } : { some, full };
}

/** `'disk'` when the reading says the disk is saturated; `undefined` when it does not, or there is no reading. */
export function classifyStallCause(pressure: IoPressure | undefined): 'disk' | undefined {
  if (pressure === undefined) return undefined;
  const full = pressure.full?.avg10 ?? 0;
  return full >= SATURATED_FULL_AVG10 || pressure.some.avg10 >= SATURATED_SOME_AVG10 ? 'disk' : undefined;
}

export function ioPressureView(pressure: IoPressure): IoPressureView {
  return {
    someAvg10: pressure.some.avg10,
    ...(pressure.full === undefined ? {} : { fullAvg10: pressure.full.avg10 }),
    saturated: classifyStallCause(pressure) === 'disk',
  };
}

/** The disk's pressure as the last reading saw it: synchronous and cached, so recording a stall never waits on the disk. */
export interface IoPressureSource {
  current(): IoPressure | undefined;
  /** Keeps the reading fresh until the function it returns is called. */
  start(): () => void;
}

// ── the event-loop lag meter ────────────────────────────────────────────────────────────────────────────────────────

/**
 * One period during which the loop could not run anything. `during`, `innermost` and `stacks` are the work that was
 * labelled in flight and the sampled stack (today's names): this kernel keeps neither, so they are always empty.
 */
export interface LoopStall {
  readonly at: Instant;
  readonly durationMs: number;
  readonly during: readonly string[];
  readonly innermost: readonly string[];
  readonly stacks: readonly { readonly stack: string; readonly share: number }[];
  /** `disk` when the disk was saturated as the stall was recorded: the loop was slow on IO, not wedged. */
  readonly cause?: 'disk';
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
  readonly worstStall?: LoopStall;
  /** The disk's pressure now, where the host reports it. */
  readonly io?: IoPressureView;
}

/** A tick every quarter second, and a stall at a quarter second late (the daemon's budget is no stall over 100 ms). */
export const LOOP_INTERVAL_MS = 250;
const LOOP_STALL_MS = 250;

export interface LoopMeter {
  /** One tick of the timer. */
  tick(): void;
  /** Total ms the loop has been unable to run, through NOW (an unfired late tick counts). Never decreasing. */
  blockedMs(): number;
  view(): EventLoopView;
}

export function createLoopMeter(options: {
  readonly nowMs: () => number;
  readonly io?: () => IoPressure | undefined;
  readonly intervalMs?: number;
  readonly stallMs?: number;
  readonly onStall?: (stall: LoopStall) => void;
}): LoopMeter {
  const { nowMs } = options;
  const intervalMs = options.intervalMs ?? LOOP_INTERVAL_MS;
  const stallMs = options.stallMs ?? LOOP_STALL_MS;
  const pressure = options.io ?? ((): undefined => undefined);
  let lastTickMs = nowMs();
  let lagMs = 0;
  let maxLagMs = 0;
  let blockedMs = 0;
  let stalls = 0;
  let lastStall: LoopStall | undefined;
  let worstStall: LoopStall | undefined;
  return {
    tick() {
      const now = nowMs();
      lagMs = Math.max(0, now - lastTickMs - intervalMs);
      lastTickMs = now;
      maxLagMs = Math.max(maxLagMs, lagMs);
      blockedMs += lagMs;
      if (lagMs < stallMs) return;
      const reading = pressure();
      const cause = classifyStallCause(reading);
      stalls += 1;
      const stall: LoopStall = {
        at: instantFromEpochMs(now),
        durationMs: lagMs,
        during: [],
        innermost: [],
        stacks: [],
        ...(cause === undefined ? {} : { cause }),
        ...(reading === undefined ? {} : { io: ioPressureView(reading) }),
      };
      lastStall = stall;
      if (worstStall === undefined || stall.durationMs > worstStall.durationMs) worstStall = stall;
      options.onStall?.(stall);
    },
    blockedMs: () => blockedMs + Math.max(0, nowMs() - lastTickMs - intervalMs),
    view() {
      const reading = pressure();
      return {
        lagMs,
        maxLagMs,
        stalls,
        ...(lastStall === undefined ? {} : { lastStall }),
        ...(worstStall === undefined ? {} : { worstStall }),
        ...(reading === undefined ? {} : { io: ioPressureView(reading) }),
      };
    },
  };
}

/** The line a stall writes to the log: how long, and the disk's part in it. */
export function describeLoopStall(stall: LoopStall): string {
  const disk = stall.cause === undefined ? '' : ' — the disk is saturated, so the daemon is slow, not dead';
  return `event loop stalled for ${(stall.durationMs / 1_000).toFixed(1)}s${disk}`;
}

// ── the watchdog ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The watchdog's verdict on a heartbeat last seen `silentMs` ago. A process whose loop has stopped answers no request and
 * handles no SIGTERM, so it holds the home's lock and port forever: a thread of its own ends it so a service manager
 * starts a fresh one. `limitMs` 0 switches it off.
 */
export function watchdogShouldFire(silentMs: number, limitMs: number): boolean {
  return limitMs > 0 && silentMs >= limitMs;
}

/**
 * Where the silence is measured from: the later of the last heartbeat and the moment the process last RESUMED. A
 * machine that sleeps suspends every thread, so on waking the heartbeat is as old as the sleep; the tell is the check's
 * OWN lateness. Self-contained: the thread embeds it by its source.
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

/** What the watchdog says just before it ends the daemon. Self-contained: the thread embeds it by its source. */
export function describeWatchdogFire(silentMs: number, during: string): string {
  const suspects = during === '' ? 'no named work was in flight' : `during ${during}`;
  return `watchdog: the event loop has not run for ${(silentMs / 1_000).toFixed(0)}s (${suspects}) — ending this process so its service manager starts a fresh one`;
}

/** The port the watchdog thread is driven through. */
export interface LoopWatchdogPort {
  /** The loop ran just now; `during` names the work in flight, for the line the watchdog writes. */
  beat(during: readonly string[]): void;
  stop(): void;
}

/** The variable that sets how many seconds the loop may be silent before the watchdog ends the daemon; `0` is off. */
export const WATCHDOG_VARIABLE = 'FYD_WATCHDOG_SECONDS';
/** Five minutes: the relay gives up on a socket after 45 s, so a loop silent this long is serving nobody. */
export const DEFAULT_WATCHDOG_LIMIT_MS = 300_000;

/** The limit for this `FYD_WATCHDOG_SECONDS` value: absent is the default, `0` is off, a non-number throws naming it. */
export function parseWatchdogLimit(raw: string | undefined): number {
  const text = raw?.trim() ?? '';
  if (text === '') return DEFAULT_WATCHDOG_LIMIT_MS;
  if (!/^\d+$/u.test(text)) throw new Error(`${WATCHDOG_VARIABLE} must be a whole number of seconds: ${text}`);
  return Number(text) * 1_000;
}
