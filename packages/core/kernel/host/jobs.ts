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
  retry?: Cancel;
  firstRun: Promise<void>;
  markFirst: () => void;
  controller: AbortController;
  /** The latest repair waiting on an aborted run; an older one that settles later does nothing. */
  resuming?: object;
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

/** How long stopping waits for running jobs to honour their abort signal before it names the ones that did not. */
export const DEFAULT_STOP_DEADLINE_MS = 10_000;

export interface JobRunnerOptions {
  /** How long `stop` waits for running jobs. Default {@link DEFAULT_STOP_DEADLINE_MS}. */
  readonly stopDeadlineMs?: number;
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
  private cancelLaneOpen: (() => void) | undefined;
  private laneOpensAtMs = 0;
  private readonly yieldToLoop: () => Promise<void>;
  private readonly paused = new Set<string>();

  constructor(
    private readonly clock: Clock,
    private readonly log: Log,
    private readonly serving: (plugin: string) => boolean = () => true,
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
    const job: Job = {
      plugin,
      spec,
      key,
      runs: 0,
      failures: 0,
      consecutive: 0,
      again: false,
      firstRun,
      markFirst,
      controller: new AbortController(),
    };
    this.jobs.set(key, job);
    this.startOrder.push(key);
    if (this.started) this.arm(job);
  }

  /** Arms every job in the order they were added (which is start order: halves add jobs in `build`). */
  start(): void {
    if (this.started) return;
    this.started = true;
    // The lane opens this long after start; its timer is armed only while a lane job waits.
    this.laneOpensAtMs = this.clock.nowMs() + (this.options.backgroundDelayMs ?? DEFAULT_BACKGROUND_DELAY_MS);
    for (const key of this.startOrder) {
      const job = this.jobs.get(key);
      if (job !== undefined) this.arm(job);
    }
  }

  private arm(job: Job): void {
    const signal = job.controller.signal;
    const waitFor = (job.spec.after ?? []).map(id => this.jobs.get(id.includes('/') ? id : `${job.plugin}/${id}`));
    const ready = Promise.all(waitFor.map(other => other?.firstRun ?? Promise.resolve()));
    void ready.then(() => {
      if (signal.aborted || !this.available(job)) return;
      this.schedule(job, job.spec.schedule, true);
    });
  }

  private schedule(job: Job, schedule: JobSchedule, first: boolean): void {
    if (!this.available(job)) return;
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
    if (!this.available(job)) return;
    if (job.running !== undefined) {
      job.again = true;
      return;
    }
    if (job.spec.lane === 'worker') {
      // A fire while the job already waits does not queue a second copy: the waiting one sees the newer state.
      if (!this.waiting.includes(job)) this.waiting.push(job);
      this.armLane();
      void this.drain();
      return;
    }
    this.run(job);
  }

  /** Opens the lane at its time (start + the background delay), armed once while a lane job waits for it. */
  private armLane(): void {
    if (this.laneOpen || this.cancelLaneOpen !== undefined) return;
    this.cancelLaneOpen = this.clock.after(milliseconds(Math.max(0, this.laneOpensAtMs - this.clock.nowMs())), () => {
      this.cancelLaneOpen = undefined;
      this.laneOpen = true;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (!this.laneOpen || this.draining) return;
    this.draining = true;
    try {
      for (let job = this.waiting.shift(); job !== undefined; job = this.waiting.shift()) {
        if (this.controller.signal.aborted) break;
        // A job paused (its owner damaged) or stopped while it waited is dropped, never run.
        if (!this.available(job)) continue;
        this.run(job);
        await job.running?.catch(() => undefined);
        await this.yieldToLoop();
      }
    } finally {
      this.draining = false;
    }
  }

  private run(job: Job): void {
    // A run supersedes the retry waiting for it: a job is retried by ONE timer, so a fire that arrives while a retry is
    // pending (a kick, a second schedule) cancels that timer before the new attempt can store another over it.
    job.retry?.();
    job.retry = undefined;
    job.running = (async () => {
      try {
        await job.spec.run(job.controller.signal);
        job.runs += 1;
        job.consecutive = 0;
      } catch (error) {
        // A job that answers its own abort by throwing (`throwIfAborted`) is the stop working, not a failure.
        if (job.controller.signal.aborted) return;
        job.failures += 1;
        job.consecutive += 1;
        job.lastError = error instanceof Error ? error.message.slice(0, 200) : 'failed';
        this.log.warn('a job failed', { job: job.key, failures: job.failures });
        const delay = BACKOFF_MS[Math.min(job.consecutive - 1, BACKOFF_MS.length - 1)] as number;
        if (this.available(job)) job.retry = this.clock.after(milliseconds(delay), () => this.fire(job));
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
    this.cancelLaneOpen?.();
    this.waiting.length = 0;
    for (const key of [...this.startOrder].reverse()) {
      const job = this.jobs.get(key);
      job?.controller.abort();
      job?.cancel?.();
      job?.retry?.();
    }
    await this.waitForRunning();
  }

  /**
   * Waits for the jobs still running, but only for {@link JobRunnerOptions.stopDeadlineMs}: a job that ignores its abort
   * signal is named in the log and left behind, so stopping the daemon (and releasing its home) never waits on it.
   */
  private async waitForRunning(): Promise<void> {
    const running = [...this.startOrder].reverse().flatMap(key => {
      const job = this.jobs.get(key);
      return job?.running === undefined ? [] : [{ key, done: job.running.catch(() => undefined) }];
    });
    if (running.length === 0) return;
    const finished = new Set<string>();
    await new Promise<void>(resolve => {
      const give = this.clock.after(milliseconds(this.options.stopDeadlineMs ?? DEFAULT_STOP_DEADLINE_MS), () => {
        for (const { key } of running)
          if (!finished.has(key)) this.log.warn('a job ignored its stop signal and was left running', { job: key });
        resolve();
      });
      let left = running.length;
      for (const { key, done } of running)
        void done.then(() => {
          finished.add(key);
          left -= 1;
          if (left === 0) {
            give();
            resolve();
          }
        });
    });
  }

  private available(job: Job): boolean {
    return (
      !this.controller.signal.aborted &&
      !job.controller.signal.aborted &&
      !this.paused.has(job.plugin) &&
      this.serving(job.plugin)
    );
  }

  /** Damage revokes an owner's scheduled and running work before another call may start it. */
  pause(plugin: string): void {
    this.paused.add(plugin);
    for (let index = this.waiting.length - 1; index >= 0; index -= 1)
      if (this.waiting[index]?.plugin === plugin) this.waiting.splice(index, 1);
    if (this.waiting.length === 0) {
      this.cancelLaneOpen?.();
      this.cancelLaneOpen = undefined;
    }
    for (const job of this.jobs.values()) {
      if (job.plugin !== plugin) continue;
      job.controller.abort();
      job.cancel?.();
      job.retry?.();
      job.again = false;
    }
  }

  /** A repaired owner's jobs can start again, after any aborted run has settled. */
  resume(plugin: string): void {
    if (!this.paused.delete(plugin)) return;
    for (const job of this.jobs.values()) {
      if (job.plugin !== plugin) continue;
      // Damage and repair can repeat while one aborted run is still settling: only the latest repair arms the job,
      // and any timer already armed is cancelled first, so the job never runs on two timers.
      const token = {};
      job.resuming = token;
      const resume = (): void => {
        if (job.resuming !== token) return;
        job.resuming = undefined;
        if (this.paused.has(plugin) || this.controller.signal.aborted) return;
        job.controller = new AbortController();
        job.cancel?.();
        job.cancel = undefined;
        if (this.started) this.arm(job);
      };
      if (job.running === undefined) resume();
      else void job.running.finally(resume);
    }
  }

  /** A failed synchronous build never owns registrations. Release them instead of starting them later. */
  async discard(plugin: string): Promise<void> {
    this.pause(plugin);
    for (const [key, job] of this.jobs) {
      if (job.plugin !== plugin) continue;
      await job.running?.catch(() => undefined);
      job.markFirst();
      this.jobs.delete(key);
      const index = this.startOrder.indexOf(key);
      if (index >= 0) this.startOrder.splice(index, 1);
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
