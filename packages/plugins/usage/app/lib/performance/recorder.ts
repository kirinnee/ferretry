/**
 * WHAT THIS BROWSER SPENT ITS TIME ON, KEPT CHEAPLY AND REPORTED BY WINDOW.
 *
 * "It is always lagging" has three different causes on this side of the wire, and they need three
 * different fixes: too many requests (the app asks for what it already knows), slow requests (the
 * daemon or the carrier is slow to answer), and a busy main thread (the app itself is slow to draw).
 * The recorder keeps one sample per request, per long task and per measured render, and `report`
 * folds a window of them into numbers a person can compare with the daemon's own report.
 *
 * IT KEEPS NO CONTENT. A request is kept as its route pattern (`route-pattern.ts`), its duration,
 * its status class and its sizes; a render as the surface's fixed name and its duration. Nothing in
 * a sample can carry an id, a body or a header, so nothing in a report can either.
 *
 * IT IS BOUNDED. Samples older than the longest window anyone can ask for are dropped as new ones
 * arrive, and each kind is capped, so a tab left open for a week costs the same as one opened an
 * hour ago.
 */

/** A monotonic millisecond clock: `performance.now()` in the browser, a hand-moved one in a test. */
export interface PerformanceClock {
  readonly now: () => number;
}

/** How a request ended: an HTTP status, a transport failure, or the caller gave up on it. */
export type RequestOutcome = number | 'failed' | 'aborted';

export interface RequestSample {
  /** A route pattern, never a URL (`routePattern`). */
  readonly route: string;
  /** When it was sent, on the recorder's clock. */
  readonly at: number;
  /** Sent until answered (or failed). */
  readonly durationMs: number;
  readonly outcome: RequestOutcome;
  readonly bytesIn: number;
  readonly bytesOut: number;
}

interface Timed {
  readonly at: number;
  readonly durationMs: number;
}

interface StreamSample {
  readonly at: number;
  readonly route: string;
}

interface RenderSample extends Timed {
  readonly surface: string;
}

export interface RouteStats {
  readonly route: string;
  readonly count: number;
  readonly perMinute: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  /** Transport failures, aborts and 5xx answers: what the person would have seen go wrong. */
  readonly failed: number;
}

interface RenderStats {
  readonly surface: string;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface PwaPerformanceReport {
  /** The window that was asked for. */
  readonly windowMs: number;
  /** How much of it was recorded: less than asked when recording started inside the window. */
  readonly coveredMs: number;
  readonly requests: {
    readonly count: number;
    readonly perMinute: number;
    readonly bytesIn: number;
    readonly bytesOut: number;
    readonly failed: number;
  };
  /** Busiest first. */
  readonly routes: readonly RouteStats[];
  /** Live streams opened (event feeds, terminals), busiest first. */
  readonly streams: readonly { readonly route: string; readonly opened: number }[];
  readonly longTasks: {
    /** Whether this browser reports long tasks at all; `false` means the zeros below mean nothing. */
    readonly observed: boolean;
    readonly count: number;
    readonly totalMs: number;
    readonly maxMs: number;
  };
  /** Slowest p95 first. */
  readonly renders: readonly RenderStats[];
}

export interface PerformanceRecorderLimits {
  /** The longest window `report` answers for; older samples are dropped. */
  readonly retainMs: number;
  /** The most samples of any one kind kept at once. */
  readonly maxSamples: number;
}

const DEFAULT_PERFORMANCE_LIMITS: PerformanceRecorderLimits = { retainMs: 60 * 60_000, maxSamples: 20_000 };

/** Nearest-rank percentile of an ascending list; 0 for none. */
const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1] ?? 0;
};

const rounded = (value: number): number => Math.round(value * 10) / 10;

/** Appends `value` to `key`'s list, creating it on first sight. */
const groupInto = <T>(groups: Map<string, T[]>, key: string, value: T): void => {
  const group = groups.get(key);
  if (group === undefined) groups.set(key, [value]);
  else group.push(value);
};

const failedOutcome = (outcome: RequestOutcome): boolean => typeof outcome !== 'number' || outcome >= 500;

/** A bounded, time-ordered list: appends are O(1), and trimming drops from the front in one splice. */
class SampleLog<T extends { readonly at: number }> {
  readonly #items: T[] = [];
  readonly #limits: PerformanceRecorderLimits;

  constructor(limits: PerformanceRecorderLimits) {
    this.#limits = limits;
  }

  add(item: T, now: number): void {
    this.#items.push(item);
    const oldest = now - this.#limits.retainMs;
    let drop = Math.max(0, this.#items.length - this.#limits.maxSamples);
    while (drop < this.#items.length && (this.#items[drop]?.at ?? now) < oldest) drop += 1;
    if (drop > 0) this.#items.splice(0, drop);
  }

  since(from: number): T[] {
    return this.#items.filter(item => item.at >= from);
  }

  clear(): void {
    this.#items.length = 0;
  }
}

export class PerformanceRecorder {
  readonly clock: PerformanceClock;
  readonly #requests: SampleLog<RequestSample>;
  readonly #streams: SampleLog<StreamSample>;
  readonly #longTasks: SampleLog<Timed>;
  readonly #renders: SampleLog<RenderSample>;
  #startedAt: number;
  #longTasksObserved = false;

  constructor(clock: PerformanceClock, limits: PerformanceRecorderLimits = DEFAULT_PERFORMANCE_LIMITS) {
    this.clock = clock;
    this.#requests = new SampleLog(limits);
    this.#streams = new SampleLog(limits);
    this.#longTasks = new SampleLog(limits);
    this.#renders = new SampleLog(limits);
    this.#startedAt = clock.now();
  }

  /** Forgets everything so far: the next report covers only what happens from now. */
  start(): void {
    this.#requests.clear();
    this.#streams.clear();
    this.#longTasks.clear();
    this.#renders.clear();
    this.#startedAt = this.clock.now();
  }

  recordRequest(sample: RequestSample): void {
    this.#requests.add(sample, this.clock.now());
  }

  recordStream(route: string): void {
    const now = this.clock.now();
    this.#streams.add({ at: now, route }, now);
  }

  /** Says this browser reports long tasks, so a report can tell "none" from "not measured". */
  observingLongTasks(): void {
    this.#longTasksObserved = true;
  }

  recordLongTask(at: number, durationMs: number): void {
    this.#longTasks.add({ at, durationMs }, this.clock.now());
  }

  recordRender(surface: string, durationMs: number): void {
    const now = this.clock.now();
    this.#renders.add({ at: now, surface, durationMs }, now);
  }

  /** The last `windowMs` of what was recorded, or everything since `start` when that is shorter. */
  report(windowMs: number): PwaPerformanceReport {
    const now = this.clock.now();
    const from = Math.max(now - windowMs, this.#startedAt);
    const coveredMs = Math.max(0, now - from);
    const minutes = coveredMs / 60_000;
    const perMinute = (count: number): number => (minutes <= 0 ? 0 : rounded(count / minutes));

    const requests = this.#requests.since(from);
    const byRoute = new Map<string, RequestSample[]>();
    for (const sample of requests) groupInto(byRoute, sample.route, sample);
    const routes = [...byRoute.entries()].map(([route, samples]): RouteStats => {
      const durations = samples.map(sample => sample.durationMs).sort((left, right) => left - right);
      return {
        route,
        count: samples.length,
        perMinute: perMinute(samples.length),
        p50Ms: rounded(percentile(durations, 0.5)),
        p95Ms: rounded(percentile(durations, 0.95)),
        maxMs: rounded(durations.at(-1) ?? 0),
        bytesIn: samples.reduce((sum, sample) => sum + sample.bytesIn, 0),
        bytesOut: samples.reduce((sum, sample) => sum + sample.bytesOut, 0),
        failed: samples.filter(sample => failedOutcome(sample.outcome)).length,
      };
    });
    routes.sort((left, right) => right.count - left.count || left.route.localeCompare(right.route));

    const opened = new Map<string, number>();
    for (const stream of this.#streams.since(from)) opened.set(stream.route, (opened.get(stream.route) ?? 0) + 1);

    const longTasks = this.#longTasks.since(from);
    const byRender = new Map<string, number[]>();
    for (const render of this.#renders.since(from)) groupInto(byRender, render.surface, render.durationMs);
    const renders = [...byRender.entries()].map(([surface, durations]): RenderStats => {
      const sorted = [...durations].sort((left, right) => left - right);
      return {
        surface,
        count: sorted.length,
        p50Ms: rounded(percentile(sorted, 0.5)),
        p95Ms: rounded(percentile(sorted, 0.95)),
        maxMs: rounded(sorted.at(-1) ?? 0),
      };
    });
    renders.sort((left, right) => right.p95Ms - left.p95Ms || left.surface.localeCompare(right.surface));

    return {
      windowMs,
      coveredMs: Math.round(coveredMs),
      requests: {
        count: requests.length,
        perMinute: perMinute(requests.length),
        bytesIn: routes.reduce((sum, route) => sum + route.bytesIn, 0),
        bytesOut: routes.reduce((sum, route) => sum + route.bytesOut, 0),
        failed: routes.reduce((sum, route) => sum + route.failed, 0),
      },
      routes,
      streams: [...opened.entries()]
        .map(([route, count]) => ({ route, opened: count }))
        .sort((left, right) => right.opened - left.opened || left.route.localeCompare(right.route)),
      longTasks: {
        observed: this.#longTasksObserved,
        count: longTasks.length,
        totalMs: rounded(longTasks.reduce((sum, task) => sum + task.durationMs, 0)),
        maxMs: rounded(Math.max(0, ...longTasks.map(task => task.durationMs))),
      },
      renders,
    };
  }
}
