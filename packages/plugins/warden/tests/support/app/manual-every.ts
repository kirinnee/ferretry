/**
 * A repeating timer the test fires by hand: the `every` a polling hook takes in place of the shell's clock. No wall
 * clock, no sleeping, so a test cannot race the runner's CPU.
 */
export interface ManualEvery {
  /** The `every` to hand the hook. */
  readonly every: (run: () => void, ms: number) => () => void;
  /** Timers that were started and not cancelled. */
  readonly active: () => number;
  /** Runs every active timer's callback once, in the order they were started. */
  readonly fire: () => void;
}

export const manualEvery = (): ManualEvery => {
  const timers = new Set<() => void>();
  return {
    every: run => {
      timers.add(run);
      return () => {
        timers.delete(run);
      };
    },
    active: () => timers.size,
    fire: () => {
      for (const run of [...timers]) run();
    },
  };
};
