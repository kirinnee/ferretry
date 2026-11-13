import type { Duration } from '@ferretry/std';
import { instantFromEpochMs } from '@ferretry/std';
import type { Clock } from '../../contract/ports.ts';

/** The real clock: the only place the kernel's halves see `Date.now` and timers (`banned-globals`, §7.7). */
export function systemClock(): Clock {
  return {
    now: () => instantFromEpochMs(Date.now()),
    nowMs: () => Date.now(),
    after: (delay: Duration, fn: () => void) => {
      const timer = setTimeout(fn, delay);
      return () => clearTimeout(timer);
    },
    every: (interval: Duration, fn: () => void) => {
      const timer = setInterval(fn, Math.max(1, interval));
      return () => clearInterval(timer);
    },
    sleep: (delay: Duration, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
}

/**
 * The clock `fyd --check` hands the plugin checks: it runs on the timer functions and `Date.now` the caller copied
 * BEFORE any plugin was loaded, never on the globals, so a selftest that patches `setTimeout` cannot switch off the
 * timeout of the next one.
 */
export function copiedClock(
  arm: (fn: () => void, delay: number) => unknown,
  disarm: (timer: never) => void,
  nowMs: () => number,
): Pick<Clock, 'after' | 'nowMs'> {
  return {
    nowMs,
    after: (delay: Duration, fn: () => void) => {
      const timer = arm(fn, delay);
      return () => (disarm as (timer: unknown) => void)(timer);
    },
  };
}
