import type { RelayCrypto } from '@ferretry/app';

/**
 * A `RelayCrypto` that remembers which of its answers are still on the way, so a test can wait for
 * that work itself instead of counting event-loop turns.
 *
 * `crypto.subtle` finishes on a work-queue thread. While the main thread waits for it, a turn costs
 * microseconds, so any fixed count of turns is really a few milliseconds of wall clock, and a loaded
 * runner that leaves the work-queue thread unscheduled for longer loses the race.
 */
export const watchedCrypto = (inner: RelayCrypto): { crypto: RelayCrypto; answered: () => Promise<void> } => {
  const pending = new Set<Promise<unknown>>();
  const crypto = new Proxy(inner, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        const out: unknown = Reflect.apply(value, target, args);
        if (out instanceof Promise) {
          pending.add(out);
          const drop = (): void => {
            pending.delete(out);
          };
          out.then(drop, drop);
        }
        return out;
      };
    },
  });
  const answered = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };
  return { crypto, answered };
};
