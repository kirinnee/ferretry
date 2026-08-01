/**
 * The sweep LOOP: the timer that makes supervision happen without anyone asking,
 * and the serialization that stops two sweeps racing each other's state.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES IN THE COMPOSITION ROOT. Both of the
 * decisions here have already been made wrongly somewhere and cost something:
 *
 * - SERIALIZATION. The periodic sweep and a manual `POST /v1/warden/run` mutate
 *   the same durable document. Two overlapping runs each read it before the other
 *   wrote, so the second resurrects a spawn gap the first had already spent and
 *   the pair can put two wardens on the host against a cap of one. The chain here
 *   makes every run wait for the previous one, and it survives a FAILED run —
 *   chaining only on success would wedge supervision permanently the first time a
 *   sweep threw.
 *
 * - A SWEEP AT BOOT. Without one, `warden status` answers "no sweep has ever run"
 *   for a whole interval after every daemon restart, and on a five-minute cadence
 *   a restart loop means it never answers anything else. The boot sweep is fired
 *   and NOT awaited: a daemon must not hold its own startup on a fleet read.
 *
 * WHY THE SCHEDULER IS INJECTED. So this is testable without waiting real minutes,
 * and so the daemon's own `setInterval` stays in the composition root with every
 * other host call.
 */

/** The scheduling the loop needs, injected so a test drives it directly. */
export interface WardenScheduler {
  /** Calls `tick` every `intervalMs`, returning the cancel. */
  every(intervalMs: number, tick: () => void): () => void;
}

/** One sweep, as the loop calls it. */
export interface WardenSweepRunner<Result> {
  run(options: { readonly force: boolean }): Promise<Result>;
  intervalMs(): Promise<number>;
}

/**
 * Serializes runs and owns the timer.
 *
 * `Result` is generic so this module stays independent of the wire shape a run
 * answers with — the loop's job is ordering, not reporting.
 */
export class WardenSweepLoop<Result> {
  /** The tail of the run chain. Always settled, never rejected. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly runner: WardenSweepRunner<Result>,
    private readonly scheduler: WardenScheduler,
  ) {}

  /**
   * One sweep, after every sweep already queued.
   *
   * The chain is advanced with a swallowing continuation rather than the run's own
   * promise, so a rejected run leaves the chain settled and the NEXT run still
   * happens. The rejection itself is still delivered to this caller — an operator
   * who asked for a sweep must be told it failed.
   */
  async run(force: boolean): Promise<Result> {
    const queued = this.chain.then(async () => await this.runner.run({ force }));
    this.chain = queued.then(
      () => undefined,
      () => undefined,
    );
    return await queued;
  }

  /**
   * Arm the periodic sweep and return the disarm.
   *
   * The cadence is read ONCE, here, and the timer keeps firing on it until the
   * daemon restarts: a configuration PATCH that changes `intervalMinutes` takes
   * effect on the next boot rather than re-arming a live timer. Re-arming would
   * mean a sweep could cancel the timer that is currently running it, and the
   * daemon's own staleness detector measures lateness against the cadence it was
   * told at boot — so a timer that silently changed period would make every
   * on-time sweep look late.
   *
   * Errors from the periodic run are swallowed. An unhandled rejection from a
   * background timer takes down a daemon whose fleet is fine, and a sweep that
   * could not run is already visible as the next status response's staleness.
   */
  async arm(): Promise<() => void> {
    const intervalMs = await this.runner.intervalMs();
    const cancel = this.scheduler.every(intervalMs, () => {
      void this.run(false).catch(() => undefined);
    });
    // Fired, not awaited: a daemon must not hold startup on a fleet read, and the
    // sweep it triggers goes through the same chain as every other.
    void this.run(false).catch(() => undefined);
    return cancel;
  }
}
