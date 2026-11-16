/**
 * A `setInterval` the test fires by hand, for the one delay a hook under test uses.
 *
 * A wall-clock sleep long enough for a real interval to fire and React to flush the update is a
 * bet against the runner's CPU: on a loaded CI box the timer and the render can both land after the
 * sleep. Every other delay (React's scheduler, happy-dom) still reaches the real timer.
 */
export interface ManualInterval {
  /** Intervals of the watched delay that are scheduled and not cleared. */
  readonly active: () => number;
  /** Runs every active callback once, in the order they were scheduled. */
  readonly fire: () => void;
  readonly restore: () => void;
}

export const manualInterval = (delayMs: number): ManualInterval => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const watched = new Map<unknown, () => void>();
  let next = 1;

  globalThis.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== delayMs) return realSet(callback as () => void, delay, ...args);
    if (typeof callback !== 'function') throw new Error('the watched interval must schedule a function');
    const id = { fake: next };
    next += 1;
    watched.set(id, callback as () => void);
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer?: unknown) => {
    if (watched.delete(timer)) return;
    realClear(timer as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  return {
    active: () => watched.size,
    fire: () => {
      for (const callback of [...watched.values()]) callback();
    },
    restore: () => {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    },
  };
};
