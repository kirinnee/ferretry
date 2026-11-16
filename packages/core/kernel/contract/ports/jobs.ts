import type { Duration } from '@ferretry/std';

export type JobSchedule =
  | { readonly every: Duration }
  | { readonly cron: string }
  | { readonly onceAfterStart: true; readonly delay?: Duration };

export interface JobSpec {
  readonly id: string;
  readonly schedule: JobSchedule;
  /** Waits for each named job's first run. */
  readonly after?: readonly string[];
  /**
   * `worker`: housekeeping (today's BackgroundLane). It waits until the lane opens (`FYD_BACKGROUND_DELAY_SECONDS`
   * after the daemon serves, two minutes by default), then runs ONE lane job at a time, handing the loop back between
   * jobs; a fire while the job already waits queues no second copy. `main` (the default) runs when it fires.
   */
  readonly lane?: 'main' | 'worker';
  run(signal: AbortSignal): Promise<void>;
}

/** Jobs start after listen, in start order; a throwing job restarts with backoff and is named in `fy doctor`. */
export interface JobsPort {
  add(job: JobSpec): void;
  /** Runs a job now (e.g. after a config change), coalesced with a running one. */
  kick(id: string): void;
}
