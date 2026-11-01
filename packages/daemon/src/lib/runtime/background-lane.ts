import type { ActivityLedger } from './liveness.ts';

/**
 * ONE LANE FOR THE DAEMON'S HOUSEKEEPING, OPENED ONLY ONCE THE DAEMON HAS SETTLED.
 *
 * Analytics ingestion, the fleet refresh, the terminal reaper and Warden autoMigrate each ran on their own
 * timer, and every one of them fired at boot. On a large Mac fleet — thirty-six sessions, transcripts of
 * 200 MB, thousands of Codex rollouts — they all read and parsed at the same moment the daemon was trying
 * to answer its first requests, and the event loop stalled for seconds at a time until the daemon
 * answered nothing at all.
 *
 * None of that work is needed to serve. So it waits in this lane until the lane is opened — a couple of
 * minutes after the routes are mounted — and then runs ONE JOB AT A TIME, handing the event loop back
 * between jobs, so two passes over the same transcripts can never overlap and a request always gets a
 * turn. A timer that fires while its job is still waiting does not queue a second copy: the waiting one
 * will see the newer state anyway.
 *
 * A job that throws is swallowed, as every background timer already swallowed its own failures — an
 * unhandled rejection from housekeeping must not take down a daemon whose fleet is fine.
 */
export class BackgroundLane {
  readonly #waiting: Array<{ readonly name: string; readonly work: () => Promise<unknown> }> = [];
  #open = false;
  #closed = false;
  #draining = false;

  constructor(
    private readonly activities: ActivityLedger,
    /** Hands the event loop back, so whatever is waiting on it runs before the next job starts. */
    private readonly yieldToLoop: () => Promise<void>,
  ) {}

  /** Queues `work` as the activity `name`, unless a job of that name is already waiting. */
  submit(name: string, work: () => Promise<unknown>): void {
    if (this.#closed || this.#waiting.some(job => job.name === name)) return;
    this.#waiting.push({ name, work });
    void this.#drain();
  }

  /** Lets the lane start running what it holds, and everything submitted after. */
  open(): void {
    if (this.#closed || this.#open) return;
    this.#open = true;
    void this.#drain();
  }

  /** Drops every waiting job and runs nothing more; the job already running finishes on its own. */
  close(): void {
    this.#closed = true;
    this.#waiting.length = 0;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** The names waiting their turn, oldest first. */
  waiting(): readonly string[] {
    return this.#waiting.map(job => job.name);
  }

  async #drain(): Promise<void> {
    if (!this.#open || this.#draining) return;
    this.#draining = true;
    try {
      for (let job = this.#waiting.shift(); job !== undefined && !this.#closed; job = this.#waiting.shift()) {
        await this.activities.run(job.name, job.work).catch(() => undefined);
        await this.yieldToLoop();
      }
    } finally {
      this.#draining = false;
    }
  }
}

/** The variable that sets how long after serving the lane opens. */
export const BACKGROUND_DELAY_VARIABLE = 'FYD_BACKGROUND_DELAY_SECONDS';

/**
 * Two minutes: long enough that a browser reconnecting to a restarted daemon, and the person behind it,
 * are served before any housekeeping reads a transcript; short enough that usage and analytics are
 * current again within the same few minutes.
 */
export const DEFAULT_BACKGROUND_DELAY_MS = 120_000;

/**
 * The lane's delay for this `FYD_BACKGROUND_DELAY_SECONDS` value: absent or empty is the default, `0`
 * opens it as soon as the daemon serves, and anything that is not a whole number of seconds throws,
 * naming the variable, so a typo is heard at boot.
 */
export function parseBackgroundDelay(raw: string | undefined): number {
  const text = raw?.trim() ?? '';
  if (text === '') return DEFAULT_BACKGROUND_DELAY_MS;
  if (!/^\d+$/u.test(text)) throw new Error(`${BACKGROUND_DELAY_VARIABLE} must be a whole number of seconds: ${text}`);
  return Number(text) * 1_000;
}
