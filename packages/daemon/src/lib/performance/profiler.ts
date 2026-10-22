import {
  PERFORMANCE_REPORT_VERSION,
  type PerformanceProfileView,
  type PerformanceReport,
  type SessionWorkerPool,
} from '@ferretry/protocol';
import type { MillisecondClockPort } from '../runtime/boot.ts';
import { judgeBudgets, type PerformanceBudget } from './budgets.ts';
import type { PerformanceRecorder, PerformanceWindow } from './recorder.ts';
import { GaugeSeries, rate, round } from './stats.ts';

/** One reading of the process's own counters. Every counter is cumulative since the process started. */
export interface ProcessReading {
  readonly cpuUserMicros: number;
  readonly cpuSystemMicros: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly voluntaryContextSwitches: number;
  readonly involuntaryContextSwitches: number;
  /** Read and write system calls, sockets included; where the platform reports them (Linux). */
  readonly syscalls?: { readonly reads: number; readonly writes: number };
  /** CPU used by children this process has reaped; where the platform reports it (Linux). */
  readonly childrenCpuMs?: number;
}

/** The process's own counters, read by an adapter that can see them. */
export interface ProcessGaugePort {
  read(): Promise<ProcessReading>;
}

/** One worker thread's queue: how many requests it holds or has waiting. */
interface WorkerGaugePort {
  readonly name: string;
  inFlight(): number;
}

/** Facts about this daemon a report states once. */
export interface ProfileContextPort {
  readonly daemon: {
    readonly version: string;
    readonly platform: string;
    readonly arch: string;
    readonly runtime: string;
  };
  uptimeSeconds(): number;
  /** The stack sampler's interval in milliseconds; absent means JavaScriptCore's default. */
  readonly sampleIntervalMs?: number;
  /** The session-worker pool when the window ends; absent where the daemon has none. */
  sessionWorkers?(): SessionWorkerPool;
  /** How big the fleet is right now; `undefined` where the index cannot be read. */
  fleet(): Promise<{ readonly sessions: number; readonly running: number } | undefined>;
  /** What this daemon's report cannot see, in sentences. */
  limitations(): readonly string[];
}

/** The timers a profile runs on. Both return the function that cancels them. */
interface ProfileTimerPort {
  every(intervalMs: number, tick: () => void): () => void;
  after(delayMs: number, fire: () => void): () => void;
}

export interface PerformanceProfilerDependencies {
  readonly recorder: PerformanceRecorder;
  readonly gauges: ProcessGaugePort;
  readonly workers: readonly WorkerGaugePort[];
  readonly clock: MillisecondClockPort;
  readonly timers: ProfileTimerPort;
  readonly context: ProfileContextPort;
  readonly budgets: readonly PerformanceBudget[];
  readonly newId: () => string;
}

/** How often gauges are read through a window. */
const GAUGE_INTERVAL_MS = 1_000;
/** How many finished reports are kept for a reader that asks again. */
const KEPT_REPORTS = 3;

interface RunningProfile {
  readonly id: string;
  readonly startedAtMs: number;
  readonly endsAtMs: number;
  readonly window: PerformanceWindow;
  readonly done: Promise<PerformanceReport>;
}

const MEGABYTE = 1_048_576;

/**
 * JavaScriptCore's default sampling interval, in milliseconds: about one sample per millisecond while
 * JavaScript runs (measured: 912 a second in a busy loop, 6 a second idle), so with it the sample count
 * is roughly the JavaScript time in milliseconds.
 */
const DEFAULT_SAMPLE_INTERVAL_MS = 1;

/**
 * The sampling interval this process runs with, in milliseconds, from `BUN_JSC_sampleInterval` (which
 * JavaScriptCore reads in MICROseconds at start-up); the default when it is absent or not a positive
 * number. A daemon launched with a coarser interval takes fewer, costlier-to-skip samples, and the
 * share the stacks explain must be computed with the interval it really ran with.
 */
export function sampleIntervalMs(raw: string | undefined): number {
  const micros = Number(raw?.trim());
  return Number.isFinite(micros) && micros > 0 ? micros / 1_000 : DEFAULT_SAMPLE_INTERVAL_MS;
}

/**
 * The sentence that says how much of the CPU the stacks can explain, or nothing when they explain most
 * of it. A daemon that spends its CPU starting processes and waiting on its I/O threads shows a few
 * hundred samples against seconds of CPU, and a reader must not read the hot functions as the whole cost.
 */
export function sampledShareLimitation(
  samples: number,
  cpuMs: number,
  intervalMs: number = DEFAULT_SAMPLE_INTERVAL_MS,
): string | undefined {
  if (samples === 0 || cpuMs <= 0) return undefined;
  const share = Math.min(1, (samples * intervalMs) / cpuMs);
  if (share >= 0.5) return undefined;
  return `The sampled stacks cover about ${String(Math.round(samples * intervalMs))} ms of main-thread JavaScript, ${String(Math.round(share * 100))}% of the daemon’s ${String(Math.round(cpuMs))} ms of CPU; the rest is native work they cannot see — the I/O thread pool, the kernel, garbage collection, starting child processes.`;
}

/**
 * Opens a window onto the daemon's own counters for a number of seconds, and turns it into a report.
 *
 * ONE PROFILE RUNS AT A TIME, and asking for another while it runs joins it: two overlapping windows
 * would each see the other's reads as load, and a person pressing the button twice wants one answer.
 * A finished report is kept for a while, so a reader whose connection dropped mid-window can still
 * collect it with the id it was given.
 */
export class PerformanceProfiler {
  #running: RunningProfile | undefined;
  readonly #finished = new Map<string, PerformanceReport>();

  constructor(private readonly deps: PerformanceProfilerDependencies) {}

  /** Starts a profile of `seconds`, or answers the one already running. */
  start(seconds: number): PerformanceProfileView {
    const running = this.#running ?? this.#begin(seconds);
    return this.#runningView(running);
  }

  /** Runs a profile of `seconds` to the end and answers its report. */
  async run(seconds: number): Promise<PerformanceReport> {
    if (this.#running === undefined) this.#begin(seconds);
    // biome-ignore lint/style/noNonNullAssertion: `#begin` just set it when it was absent.
    return await this.#running!.done;
  }

  /** A profile by its id: running, finished, or unknown. */
  view(id: string): PerformanceProfileView | undefined {
    if (this.#running?.id === id) return this.#runningView(this.#running);
    const report = this.#finished.get(id);
    return report === undefined ? undefined : { state: 'finished', id, report };
  }

  #runningView(running: RunningProfile): PerformanceProfileView {
    return {
      state: 'running',
      id: running.id,
      startedAt: new Date(running.startedAtMs).toISOString(),
      endsAt: new Date(running.endsAtMs).toISOString(),
    };
  }

  #begin(seconds: number): RunningProfile {
    const { recorder, gauges, workers, clock, timers } = this.deps;
    const startedAtMs = clock.now();
    const window = recorder.open(startedAtMs);
    const memory = { rss: new GaugeSeries(), heap: new GaugeSeries(), external: new GaugeSeries() };
    const sampleGauges = (reading: ProcessReading): void => {
      memory.rss.add(reading.rssBytes / MEGABYTE);
      memory.heap.add(reading.heapUsedBytes / MEGABYTE);
      memory.external.add(reading.externalBytes / MEGABYTE);
      for (const worker of workers) window.worker(worker.name, worker.inFlight());
    };
    const done = (async () => {
      const first = await gauges.read();
      sampleGauges(first);
      const stopGauges = timers.every(GAUGE_INTERVAL_MS, () => {
        void gauges.read().then(sampleGauges, () => undefined);
      });
      await new Promise<void>(resolve => timers.after(seconds * 1_000, resolve));
      stopGauges();
      const last = await gauges.read();
      sampleGauges(last);
      recorder.close(window);
      const endedAtMs = clock.now();
      return await this.#report({ window, startedAtMs, endedAtMs, first, last, memory });
    })();
    const running: RunningProfile = {
      id: this.deps.newId(),
      startedAtMs,
      endsAtMs: startedAtMs + seconds * 1_000,
      window,
      done,
    };
    this.#running = running;
    void done.then(
      report => this.#keep(running.id, report),
      () => {
        recorder.close(window);
        this.#running = undefined;
      },
    );
    return running;
  }

  #keep(id: string, report: PerformanceReport): void {
    this.#running = undefined;
    this.#finished.set(id, report);
    while (this.#finished.size > KEPT_REPORTS) {
      const oldest = this.#finished.keys().next().value;
      if (oldest === undefined) break;
      this.#finished.delete(oldest);
    }
  }

  async #report(input: {
    window: PerformanceWindow;
    startedAtMs: number;
    endedAtMs: number;
    first: ProcessReading;
    last: ProcessReading;
    memory: { rss: GaugeSeries; heap: GaugeSeries; external: GaugeSeries };
  }): Promise<PerformanceReport> {
    const { context, budgets } = this.deps;
    const windowMs = Math.max(1, input.endedAtMs - input.startedAtMs);
    const tables = input.window.tables(windowMs);
    const userMs = Math.max(0, input.last.cpuUserMicros - input.first.cpuUserMicros) / 1_000;
    const systemMs = Math.max(0, input.last.cpuSystemMicros - input.first.cpuSystemMicros) / 1_000;
    const childrenMs =
      input.first.childrenCpuMs === undefined || input.last.childrenCpuMs === undefined
        ? undefined
        : Math.max(0, input.last.childrenCpuMs - input.first.childrenCpuMs);
    const syscalls =
      input.first.syscalls === undefined || input.last.syscalls === undefined
        ? undefined
        : {
            reads: Math.max(0, input.last.syscalls.reads - input.first.syscalls.reads),
            writes: Math.max(0, input.last.syscalls.writes - input.first.syscalls.writes),
          };
    const fleet = await context.fleet().catch(() => undefined);
    const resources: PerformanceReport['resources'] = {
      cpu: {
        userMs: round(userMs),
        systemMs: round(systemMs),
        percentOfCore: round(((userMs + systemMs) / windowMs) * 100),
        ...(childrenMs === undefined ? {} : { childrenMs: round(childrenMs) }),
      },
      memory: {
        rssMb: input.memory.rss.stats(),
        heapUsedMb: input.memory.heap.stats(),
        externalMb: input.memory.external.stats(),
      },
      ...(syscalls === undefined
        ? {}
        : { syscalls: { ...syscalls, perSecond: rate(syscalls.reads + syscalls.writes, windowMs, 1_000) } }),
      contextSwitches: {
        voluntary: Math.max(0, input.last.voluntaryContextSwitches - input.first.voluntaryContextSwitches),
        involuntary: Math.max(0, input.last.involuntaryContextSwitches - input.first.involuntaryContextSwitches),
      },
    };
    return {
      version: PERFORMANCE_REPORT_VERSION,
      startedAt: new Date(input.startedAtMs).toISOString(),
      endedAt: new Date(input.endedAtMs).toISOString(),
      windowMs,
      daemon: { ...context.daemon, uptimeSeconds: Math.round(context.uptimeSeconds()) },
      ...(fleet === undefined ? {} : { fleet }),
      ...(context.sessionWorkers === undefined ? {} : { sessionWorkers: context.sessionWorkers() }),
      resources,
      ...tables,
      budgets: judgeBudgets({ resources, ...tables }, budgets),
      limitations: [
        ...context.limitations(),
        ...[sampledShareLimitation(tables.cpuProfile.samples, userMs + systemMs, context.sampleIntervalMs)].filter(
          (line): line is string => line !== undefined,
        ),
      ],
    };
  }
}
