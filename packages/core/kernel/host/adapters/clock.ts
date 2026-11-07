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
