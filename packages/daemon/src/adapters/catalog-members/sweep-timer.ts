/** The timer functions this needs, so a test drives time by hand. */
export interface SweepClock {
  repeat(callback: () => void, ms: number): () => void;
}

export const systemSweepClock: SweepClock = {
  repeat: (callback, ms) => {
    const handle = setInterval(callback, ms);
    handle.unref();
    return () => clearInterval(handle);
  },
};

/**
 * Runs the member sweep on an interval. A sweep that throws is reported and the next one still runs: a store
 * that was briefly unwritable must not end the timer that would have cleaned it up.
 */
export class MemberSweepTimer {
  constructor(
    private readonly clock: SweepClock,
    private readonly sweep: () => Promise<unknown>,
    private readonly report: (error: unknown) => void,
  ) {}

  /** One sweep now, before the first interval: a browser time already ended must not wait an hour to be removed. */
  start(intervalMs: number): () => void {
    const run = (): void => {
      this.sweep().catch(this.report);
    };
    run();
    return this.clock.repeat(run, intervalMs);
  }
}
