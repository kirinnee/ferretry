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
  /** Calls `action` once after `delayMs`, returning the cancel. */
  after(delayMs: number, action: () => void): () => void;
  /** Wall-clock milliseconds, for "when is the next sweep". */
  nowMs(): number;
}

/** One sweep, as the loop calls it. */
export interface WardenSweepRunner<Result> {
  run(options: { readonly force: boolean }): Promise<Result>;
  intervalMs(): Promise<number>;
}

/**
 * How long an event waits before its sweep runs, so a burst — a turn ending, then the question it ends
 * on — becomes one sweep rather than two.
 */
export const WARDEN_TRIGGER_DEBOUNCE_MS = 5_000;

/**
 * The least time between two event-driven sweeps. Events are cheap to produce: a fleet of busy ferrets
 * ends turns constantly, and a sweep per turn would read the whole fleet every few seconds. The timer
 * is unaffected; this only spaces the extra sweeps.
 */
export const WARDEN_TRIGGER_MIN_GAP_MS = 60_000;

/**
 * Serializes runs and owns the timer.
 *
 * `Result` is generic so this module stays independent of the wire shape a run
 * answers with — the loop's job is ordering, not reporting.
 */
export class WardenSweepLoop<Result> {
  /** The tail of the run chain. Always settled, never rejected. */
  private chain: Promise<void> = Promise.resolve();
  private armed: { readonly atMs: number; readonly intervalMs: number } | undefined;
  private pendingTrigger: (() => void) | undefined;
  private lastTriggeredAtMs: number | undefined;

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
    return await this.exclusive(async () => await this.runner.run({ force }));
  }

  /**
   * Any other change to the sweep's durable state, in the same chain as the sweeps — an owner's request
   * for an investigation writes the queue a running sweep would otherwise overwrite.
   */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const queued = this.chain.then(work);
    this.chain = queued.then(
      () => undefined,
      () => undefined,
    );
    return await queued;
  }

  /**
   * Bring a sweep forward because something happened. Coalesced: while one event sweep is pending,
   * another event changes nothing, and two event sweeps are at least {@link WARDEN_TRIGGER_MIN_GAP_MS}
   * apart. Ignored before the loop is armed — a daemon that is not serving yet does not sweep.
   *
   * Answers whether this call scheduled a sweep.
   */
  trigger(): boolean {
    if (this.armed === undefined || this.pendingTrigger !== undefined) return false;
    const nowMs = this.scheduler.nowMs();
    const gapEndsAt = this.lastTriggeredAtMs === undefined ? nowMs : this.lastTriggeredAtMs + WARDEN_TRIGGER_MIN_GAP_MS;
    const delay = Math.max(WARDEN_TRIGGER_DEBOUNCE_MS, gapEndsAt - nowMs);
    this.pendingTrigger = this.scheduler.after(delay, () => {
      this.pendingTrigger = undefined;
      this.lastTriggeredAtMs = this.scheduler.nowMs();
      void this.run(false).catch(() => undefined);
    });
    return true;
  }

  /** When the timer next fires, or `undefined` before it is armed. */
  nextDueAtMs(): number | undefined {
    if (this.armed === undefined) return undefined;
    const elapsed = Math.max(0, this.scheduler.nowMs() - this.armed.atMs);
    return this.armed.atMs + (Math.floor(elapsed / this.armed.intervalMs) + 1) * this.armed.intervalMs;
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
    this.armed = { atMs: this.scheduler.nowMs(), intervalMs };
    // Fired, not awaited: a daemon must not hold startup on a fleet read, and the
    // sweep it triggers goes through the same chain as every other.
    void this.run(false).catch(() => undefined);
    return () => {
      this.armed = undefined;
      this.pendingTrigger?.();
      this.pendingTrigger = undefined;
      cancel();
    };
  }
}
