import type {
  ActivityStats,
  ChildProcessStats,
  FileOperationStats,
  HotFunction,
  HotStack,
  PerformanceReport,
  ReportedStall,
  RouteStats,
  WorkerStats,
  WorkerWork,
} from '@ferretry/protocol';
import { describeFrame, type LoopStall, type StackSample } from '../runtime/liveness.ts';
import { DurationSeries, GaugeSeries, percentile, rate, round } from './stats.ts';

/**
 * THE ONE THING EVERY INSTRUMENT CALLS.
 *
 * The daemon's activities, routes, child processes, file ports, lag meter and stack sampler each report
 * what they just did here, and the recorder hands it to every profile window that is open. With no
 * window open, every call returns before doing anything — so the instruments can stay wired into a
 * production daemon permanently, and a profile is a window opened onto work that was always counted,
 * not a different daemon that behaves differently because it is being watched.
 */
export interface PerformanceProbe {
  /** Whether any window is open. An instrument that must do work to describe an event checks it first. */
  readonly recording: boolean;
  activity(name: string, wallMs: number): void;
  route(route: string, wallMs: number, status: number, bytes: number): void;
  /**
   * A child was started; `synchronous` when it held the loop until it exited, `activity` the labelled
   * work that started it.
   */
  childStarted(command: string, synchronous: boolean, activity?: string): void;
  childExited(command: string, wallMs: number): void;
  fileOperation(operation: string, path: string, wallMs: number): void;
  /** How late one lag tick fired. */
  loopTick(lagMs: number): void;
  stall(stall: LoopStall): void;
  samples(samples: readonly StackSample[]): void;
  /**
   * One job a worker thread finished, as the worker itself reported it; `activity` the main-thread work
   * that asked for it. A worker's children and file reads are invisible to every other instrument here.
   */
  workerJob(name: string, job: WorkerJobReport, activity?: string): void;
}

/** What one worker job cost, as the worker reported it. Commands are already labelled by program. */
export interface WorkerJobReport {
  readonly wallMs: number;
  readonly children: readonly { readonly command: string; readonly wallMs: number }[];
  readonly fileReads: number;
  readonly fetches: number;
  readonly heapBytes: number;
}

/** A probe that records nothing, for tests and for a daemon built without a profiler. */
export const NO_PERFORMANCE_PROBE: PerformanceProbe = Object.freeze({
  recording: false,
  activity: () => undefined,
  route: () => undefined,
  childStarted: () => undefined,
  childExited: () => undefined,
  fileOperation: () => undefined,
  loopTick: () => undefined,
  stall: () => undefined,
  samples: () => undefined,
  workerJob: () => undefined,
});

/** A loop block this long or longer is counted, and the two thresholds the report names. */
const BLOCK_100_MS = 100;
const BLOCK_250_MS = 250;
/** What a child started outside any labelled work is attributed to. */
const UNLABELLED_ACTIVITY = '(no named work)';
/** How many starters each child-process row names. */
const STARTERS = 3;
/** How many of each table a report carries: enough to rank, few enough to read. */
export const REPORT_TOP = 25;
const STALL_LIMIT = 10;
const STACK_DEPTH = 8;

interface ChildSeries {
  started: number;
  synchronous: number;
  readonly wall: DurationSeries;
  readonly by: Map<string, number>;
}

interface WorkerWorkSeries {
  readonly wall: DurationSeries;
  readonly children: Map<string, ChildSeries>;
  fileReads: number;
  fetches: number;
  readonly heapMb: GaugeSeries;
}

interface RouteSeries {
  readonly wall: DurationSeries;
  errors: number;
  bytes: number;
  maxBytes: number;
}

/** Everything one window has seen, folded as it arrives. */
export class PerformanceWindow {
  readonly #activities = new Map<string, DurationSeries>();
  readonly #routes = new Map<string, RouteSeries>();
  readonly #children = new Map<string, ChildSeries>();
  readonly #files = new Map<string, DurationSeries>();
  readonly #lags: number[] = [];
  readonly #stalls: LoopStall[] = [];
  readonly #self = new Map<string, number>();
  readonly #inclusive = new Map<string, number>();
  readonly #stacks = new Map<string, number>();
  readonly #workers = new Map<string, GaugeSeries>();
  readonly #work = new Map<string, WorkerWorkSeries>();
  #samples = 0;
  #blocks100 = 0;
  #blocks250 = 0;
  #blockedMs = 0;

  constructor(readonly startedAtMs: number) {}

  activity(name: string, wallMs: number): void {
    series(this.#activities, name).add(wallMs);
  }

  route(route: string, wallMs: number, status: number, bytes: number): void {
    let entry = this.#routes.get(route);
    if (entry === undefined) {
      entry = { wall: new DurationSeries(), errors: 0, bytes: 0, maxBytes: 0 };
      this.#routes.set(route, entry);
    }
    entry.wall.add(wallMs);
    if (status >= 400) entry.errors += 1;
    entry.bytes += bytes;
    entry.maxBytes = Math.max(entry.maxBytes, bytes);
  }

  childStarted(command: string, synchronous: boolean, activity: string = UNLABELLED_ACTIVITY): void {
    const entry = childOf(this.#children, command);
    entry.started += 1;
    if (synchronous) entry.synchronous += 1;
    bump(entry.by, activity);
  }

  childExited(command: string, wallMs: number): void {
    childOf(this.#children, command).wall.add(wallMs);
  }

  fileOperation(operation: string, path: string, wallMs: number): void {
    series(this.#files, `${operation}\u0000${path}`).add(wallMs);
  }

  loopTick(lagMs: number): void {
    this.#lags.push(lagMs);
    if (lagMs >= BLOCK_100_MS) {
      this.#blocks100 += 1;
      this.#blockedMs += lagMs;
    }
    if (lagMs >= BLOCK_250_MS) this.#blocks250 += 1;
  }

  stall(stall: LoopStall): void {
    this.#stalls.push(stall);
  }

  samples(samples: readonly StackSample[]): void {
    for (const sample of samples) {
      const frames = sample.frames.map(describeFrame);
      const top = frames[0];
      if (top === undefined) continue;
      this.#samples += 1;
      bump(this.#self, top);
      for (const frame of new Set(frames)) bump(this.#inclusive, frame);
      bump(this.#stacks, frames.slice(0, STACK_DEPTH).join(' ← '));
    }
  }

  workerJob(name: string, job: WorkerJobReport, activity: string = UNLABELLED_ACTIVITY): void {
    let entry = this.#work.get(name);
    if (entry === undefined) {
      entry = { wall: new DurationSeries(), children: new Map(), fileReads: 0, fetches: 0, heapMb: new GaugeSeries() };
      this.#work.set(name, entry);
    }
    entry.wall.add(job.wallMs);
    for (const child of job.children) {
      const series = childOf(entry.children, child.command);
      series.started += 1;
      bump(series.by, activity);
      series.wall.add(child.wallMs);
    }
    entry.fileReads += job.fileReads;
    entry.fetches += job.fetches;
    entry.heapMb.add(job.heapBytes / 1_048_576);
  }

  worker(name: string, inFlight: number): void {
    let entry = this.#workers.get(name);
    if (entry === undefined) {
      entry = new GaugeSeries();
      this.#workers.set(name, entry);
    }
    entry.add(inFlight);
  }

  /** The window's tables, ranked, over `windowMs`. */
  tables(windowMs: number): WindowTables {
    const lags = [...this.#lags].sort((a, b) => a - b);
    const childTotal = [...this.#children.values()].reduce((sum, entry) => sum + entry.started, 0);
    const fileEntries = [...this.#files];
    const fileTotal = fileEntries.reduce((sum, [, entry]) => sum + entry.count, 0);
    return {
      eventLoop: {
        ticks: lags.length,
        lag: {
          p50Ms: round(percentile(lags, 0.5)),
          p95Ms: round(percentile(lags, 0.95)),
          maxMs: round(lags[lags.length - 1] ?? 0),
        },
        blocksOver100Ms: this.#blocks100,
        blocksOver250Ms: this.#blocks250,
        blockedMs: round(this.#blockedMs),
        stalls: [...this.#stalls]
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, STALL_LIMIT)
          .map(stall => reportedStall(stall, this.startedAtMs)),
      },
      cpuProfile: {
        samples: this.#samples,
        self: hot(this.#self, this.#samples),
        inclusive: hot(this.#inclusive, this.#samples),
        stacks: hot(this.#stacks, this.#samples).map(({ frame, ...rest }): HotStack => ({ stack: frame, ...rest })),
      },
      activities: ranked(
        [...this.#activities].map(
          ([name, wall]): ActivityStats => ({
            name,
            count: wall.count,
            perMinute: rate(wall.count, windowMs, 60_000),
            wall: wall.stats(),
          }),
        ),
        entry => entry.wall.totalMs,
      ),
      routes: ranked(
        [...this.#routes].map(
          ([route, entry]): RouteStats => ({
            route,
            count: entry.wall.count,
            perMinute: rate(entry.wall.count, windowMs, 60_000),
            errors: entry.errors,
            wall: entry.wall.stats(),
            bytes: { total: entry.bytes, max: entry.maxBytes },
          }),
        ),
        entry => entry.wall.totalMs,
      ),
      childProcesses: {
        total: childTotal,
        perMinute: rate(childTotal, windowMs, 60_000),
        commands: childStats(this.#children, windowMs),
      },
      fileOperations: {
        total: fileTotal,
        perSecond: rate(fileTotal, windowMs, 1_000),
        top: ranked(
          fileEntries.map(([key, wall]): FileOperationStats => {
            const [operation = '', path = ''] = key.split('\u0000');
            return {
              operation,
              path,
              count: wall.count,
              perSecond: rate(wall.count, windowMs, 1_000),
              wall: wall.stats(),
            };
          }),
          entry => entry.count,
        ),
      },
      workers: [...new Set([...this.#workers.keys(), ...this.#work.keys()])].sort().map((name): WorkerStats => {
        const work = this.#work.get(name);
        return {
          name,
          inFlight: (this.#workers.get(name) ?? new GaugeSeries()).stats(),
          ...(work === undefined ? {} : { work: workStats(work, windowMs) }),
        };
      }),
    };
  }
}

/** The ranked tables a window produces; the report adds the process gauges around them. */
export type WindowTables = Pick<
  PerformanceReport,
  'eventLoop' | 'cpuProfile' | 'activities' | 'routes' | 'childProcesses' | 'fileOperations' | 'workers'
>;

function childOf(children: Map<string, ChildSeries>, command: string): ChildSeries {
  let entry = children.get(command);
  if (entry === undefined) {
    entry = { started: 0, synchronous: 0, wall: new DurationSeries(), by: new Map() };
    children.set(command, entry);
  }
  return entry;
}

function childStats(children: ReadonlyMap<string, ChildSeries>, windowMs: number): ChildProcessStats[] {
  return ranked(
    [...children].map(
      ([command, entry]): ChildProcessStats => ({
        command,
        count: entry.started,
        perMinute: rate(entry.started, windowMs, 60_000),
        synchronous: entry.synchronous,
        wall: entry.wall.stats(),
        by: [...entry.by]
          .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
          .slice(0, STARTERS)
          .map(([activity, count]) => ({ activity, count })),
      }),
    ),
    entry => entry.count,
  );
}

function workStats(work: WorkerWorkSeries, windowMs: number): WorkerWork {
  return {
    jobs: work.wall.count,
    perMinute: rate(work.wall.count, windowMs, 60_000),
    wall: work.wall.stats(),
    childProcesses: childStats(work.children, windowMs),
    fileReads: work.fileReads,
    fetches: work.fetches,
    heapMb: work.heapMb.stats(),
  };
}

function series<K>(map: Map<K, DurationSeries>, key: K): DurationSeries {
  let entry = map.get(key);
  if (entry === undefined) {
    entry = new DurationSeries();
    map.set(key, entry);
  }
  return entry;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function hot(counts: ReadonlyMap<string, number>, total: number): HotFunction[] {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, REPORT_TOP)
    .map(([frame, samples]) => ({ frame, samples, share: total === 0 ? 0 : round(samples / total) }));
}

function ranked<T>(entries: readonly T[], weight: (entry: T) => number): T[] {
  return [...entries].sort((a, b) => weight(b) - weight(a)).slice(0, REPORT_TOP);
}

function reportedStall(stall: LoopStall, startedAtMs: number): ReportedStall {
  return {
    atOffsetMs: Math.max(0, round(stall.atMs - startedAtMs)),
    durationMs: round(stall.durationMs),
    during: [...stall.innermost],
    stacks: stall.stacks.map(entry => ({ stack: entry.stack, share: entry.share })),
  };
}

/**
 * The daemon's probe: forwards every event to each open window.
 *
 * It holds the open windows and nothing else, so opening one costs a set insertion and a closed one is
 * forgotten the moment it is removed.
 */
export class PerformanceRecorder implements PerformanceProbe {
  readonly #windows = new Set<PerformanceWindow>();

  get recording(): boolean {
    return this.#windows.size > 0;
  }

  open(startedAtMs: number): PerformanceWindow {
    const window = new PerformanceWindow(startedAtMs);
    this.#windows.add(window);
    return window;
  }

  close(window: PerformanceWindow): void {
    this.#windows.delete(window);
  }

  activity(name: string, wallMs: number): void {
    for (const window of this.#windows) window.activity(name, wallMs);
  }

  route(route: string, wallMs: number, status: number, bytes: number): void {
    for (const window of this.#windows) window.route(route, wallMs, status, bytes);
  }

  childStarted(command: string, synchronous: boolean, activity?: string): void {
    for (const window of this.#windows) window.childStarted(command, synchronous, activity);
  }

  childExited(command: string, wallMs: number): void {
    for (const window of this.#windows) window.childExited(command, wallMs);
  }

  fileOperation(operation: string, path: string, wallMs: number): void {
    for (const window of this.#windows) window.fileOperation(operation, path, wallMs);
  }

  loopTick(lagMs: number): void {
    for (const window of this.#windows) window.loopTick(lagMs);
  }

  stall(stall: LoopStall): void {
    for (const window of this.#windows) window.stall(stall);
  }

  samples(samples: readonly StackSample[]): void {
    if (samples.length === 0) return;
    for (const window of this.#windows) window.samples(samples);
  }

  workerJob(name: string, job: WorkerJobReport, activity?: string): void {
    for (const window of this.#windows) window.workerJob(name, job, activity);
  }
}
