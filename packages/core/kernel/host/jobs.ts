import type { Duration } from '@ferretry/std';
import { milliseconds } from '@ferretry/std';
import type { Cancel, Clock, JobSchedule, JobSpec, JobsPort, Log } from '../contract/ports.ts';

/** What `fy doctor` hears about a job. */
export interface JobReport {
  readonly plugin: string;
  readonly id: string;
  readonly runs: number;
  readonly failures: number;
  readonly lastError?: string;
}

interface Job {
  readonly plugin: string;
  readonly spec: JobSpec;
  readonly key: string;
  runs: number;
  failures: number;
  consecutive: number;
  lastError?: string;
  running?: Promise<void>;
  again: boolean;
  cancel?: Cancel;
  firstRun: Promise<void>;
  markFirst: () => void;
}

const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const;

/** The variable that sets how long after serving the background lane opens (today's). */
export const BACKGROUND_DELAY_VARIABLE = 'FYD_BACKGROUND_DELAY_SECONDS';

/**
 * Two minutes: long enough that a browser reconnecting to a restarted daemon, and the person behind it, are served
 * before any housekeeping reads a transcript; short enough that usage and analytics are current again soon after.
 */
export const DEFAULT_BACKGROUND_DELAY_MS = 120_000;

/**
 * The lane's delay for this `FYD_BACKGROUND_DELAY_SECONDS` value (today's `parseBackgroundDelay`): absent or empty is
 * the default, `0` opens it as soon as the daemon serves, anything but whole seconds throws naming the variable.
 */
export function parseBackgroundDelay(raw: string | undefined): number {
  const text = raw?.trim() ?? '';
  if (text === '') return DEFAULT_BACKGROUND_DELAY_MS;
  if (!/^\d+$/u.test(text)) throw new Error(`${BACKGROUND_DELAY_VARIABLE} must be a whole number of seconds: ${text}`);
  return Number(text) * 1_000;
}

export interface JobRunnerOptions {
  /** How long after `start` the background (`worker`) lane opens. Default {@link DEFAULT_BACKGROUND_DELAY_MS}. */
  readonly backgroundDelayMs?: number;
  /** Hands the event loop back between lane jobs, so whatever waits on it runs first. Default: one `setImmediate`. */
  readonly yieldToLoop?: () => Promise<void>;
}

/**
 * Jobs (§7.4, §7.6 step 8): interval, cron or once-after-start; started after listen in start order; `after` waits
 * for each named job's first run; a throwing job restarts with backoff and is named in `fy doctor`; `kick` runs one
 * now, coalesced with a running one. A `worker`-lane job is housekeeping (today's BackgroundLane): it waits for the
 * lane to open, then lane jobs run one at a time with the loop handed back between them, never queued twice.
 */
export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly startOrder: string[] = [];
  private started = false;
  private readonly controller = new AbortController();
  private readonly waiting: Job[] = [];
  private laneOpen = false;
  private draining = false;
  private readonly yieldToLoop: () => Promise<void>;

  constructor(
    private readonly clock: Clock,
    private readonly log: Log,
    private readonly options: JobRunnerOptions = {},
  ) {
    this.yieldToLoop = options.yieldToLoop ?? (() => new Promise<void>(resolve => setImmediate(resolve)));
  }

  /** The lane jobs waiting their turn, oldest first. */
  laneWaiting(): readonly string[] {
    return this.waiting.map(job => job.key);
  }

  portFor(plugin: string): JobsPort {
    return {
      add: spec => this.add(plugin, spec),
      kick: id => this.kick(`${plugin}/${id}`),
    };
  }

  private add(plugin: string, spec: JobSpec): void {
    const key = `${plugin}/${spec.id}`;
    if (this.jobs.has(key)) throw new TypeError(`job ${key} added twice`);
    let markFirst = (): void => {};
    const firstRun = new Promise<void>(resolve => {
      markFirst = resolve;
    });
    const job: Job = { plugin, spec, key, runs: 0, failures: 0, consecutive: 0, again: false, firstRun, markFirst };
    this.jobs.set(key, job);
    this.startOrder.push(key);
    if (this.started) this.arm(job);
  }

  /** Arms every job in the order they were added (which is start order: halves add jobs in `build`). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.clock.after(milliseconds(this.options.backgroundDelayMs ?? DEFAULT_BACKGROUND_DELAY_MS), () => {
      this.laneOpen = true;
      void this.drain();
    });
    for (const key of this.startOrder) {
      const job = this.jobs.get(key);
      if (job !== undefined) this.arm(job);
    }
  }

  private arm(job: Job): void {
    const waitFor = (job.spec.after ?? []).map(id => this.jobs.get(id.includes('/') ? id : `${job.plugin}/${id}`));
    const ready = Promise.all(waitFor.map(other => other?.firstRun ?? Promise.resolve()));
    void ready.then(() => {
      if (this.controller.signal.aborted) return;
      this.schedule(job, job.spec.schedule, true);
    });
  }

  private schedule(job: Job, schedule: JobSchedule, first: boolean): void {
    if (this.controller.signal.aborted) return;
    if ('onceAfterStart' in schedule) {
      if (first) job.cancel = this.clock.after(schedule.delay ?? milliseconds(0), () => this.fire(job));
      return;
    }
    if ('every' in schedule) {
      if (first) this.fire(job);
      job.cancel = this.clock.every(schedule.every, () => this.fire(job));
      return;
    }
    const cron = parseCron(schedule.cron);
    job.cancel = this.clock.every(milliseconds(60_000), () => {
      if (cronMatches(cron, new Date(this.clock.nowMs()))) this.fire(job);
    });
  }

  private kick(key: string): void {
    const job = this.jobs.get(key);
    if (job === undefined) throw new TypeError(`no job ${key}`);
    if (!this.started) return;
    this.fire(job);
  }

  private fire(job: Job): void {
    if (this.controller.signal.aborted) return;
    if (job.running !== undefined) {
      job.again = true;
      return;
    }
    if (job.spec.lane === 'worker') {
      // A fire while the job already waits does not queue a second copy: the waiting one sees the newer state.
      if (!this.waiting.includes(job)) this.waiting.push(job);
      void this.drain();
      return;
    }
    this.run(job);
  }

  private async drain(): Promise<void> {
    if (!this.laneOpen || this.draining) return;
    this.draining = true;
    try {
      for (let job = this.waiting.shift(); job !== undefined; job = this.waiting.shift()) {
        if (this.controller.signal.aborted) break;
        this.run(job);
        await job.running?.catch(() => undefined);
        await this.yieldToLoop();
      }
    } finally {
      this.draining = false;
    }
  }

  private run(job: Job): void {
    job.running = (async () => {
      try {
        await job.spec.run(this.controller.signal);
        job.runs += 1;
        job.consecutive = 0;
      } catch (error) {
        job.failures += 1;
        job.consecutive += 1;
        job.lastError = error instanceof Error ? error.message.slice(0, 200) : 'failed';
        this.log.warn('a job failed', { job: job.key, failures: job.failures });
        const delay = BACKOFF_MS[Math.min(job.consecutive - 1, BACKOFF_MS.length - 1)] as number;
        this.clock.after(milliseconds(delay), () => this.fire(job));
      } finally {
        job.markFirst();
        job.running = undefined;
        if (job.again) {
          job.again = false;
          this.fire(job);
        }
      }
    })();
  }

  /** Stops jobs in reverse start order and waits for running ones (§7.6 step 9). */
  async stop(): Promise<void> {
    this.controller.abort();
    this.waiting.length = 0;
    for (const key of [...this.startOrder].reverse()) {
      const job = this.jobs.get(key);
      job?.cancel?.();
      await job?.running?.catch(() => undefined);
    }
  }

  reports(): readonly JobReport[] {
    return this.startOrder.map(key => {
      const job = this.jobs.get(key) as Job;
      return {
        plugin: job.plugin,
        id: job.spec.id,
        runs: job.runs,
        failures: job.failures,
        ...(job.lastError === undefined ? {} : { lastError: job.lastError }),
      };
    });
  }

  /** Settles every job that is running now (the test host's `settle`). */
  async settle(): Promise<void> {
    await Promise.all([...this.jobs.values()].map(job => job.running?.catch(() => undefined)));
  }
}

type CronField = ReadonlySet<number> | 'any';
interface Cron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly day: CronField;
  readonly month: CronField;
  readonly weekday: CronField;
}

function field(text: string, low: number, high: number): CronField {
  if (text === '*') return 'any';
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const step = /^\*\/(\d+)$/.exec(part);
    if (step !== null) {
      for (let value = low; value <= high; value += Number(step[1])) values.add(value);
      continue;
    }
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (range === null) throw new TypeError(`cron field "${text}"`);
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from < low || to > high || from > to) throw new TypeError(`cron field "${text}"`);
    for (let value = from; value <= to; value += 1) values.add(value);
  }
  return values;
}

// Five fields, UTC: minute hour day-of-month month day-of-week; `*`, `*/n`, `a-b`, lists.
export function parseCron(text: string): Cron {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) throw new TypeError(`cron "${text}" needs five fields`);
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  return {
    minute: field(minute, 0, 59),
    hour: field(hour, 0, 23),
    day: field(day, 1, 31),
    month: field(month, 1, 12),
    weekday: field(weekday, 0, 6),
  };
}

export function cronMatches(cron: Cron, at: Date): boolean {
  const hit = (set: CronField, value: number): boolean => set === 'any' || set.has(value);
  return (
    hit(cron.minute, at.getUTCMinutes()) &&
    hit(cron.hour, at.getUTCHours()) &&
    hit(cron.day, at.getUTCDate()) &&
    hit(cron.month, at.getUTCMonth() + 1) &&
    hit(cron.weekday, at.getUTCDay())
  );
}

export type { Duration };
