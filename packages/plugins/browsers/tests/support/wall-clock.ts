import type { Clock } from '@ferretry/kernel/contract';
import { instantFromEpochMs } from '@ferretry/std';

/** The wall clock, for an integration test that runs real sockets and real timers (the host's `systemClock`). */
export function wallClock(): Clock {
  return {
    now: () => instantFromEpochMs(Date.now()),
    nowMs: () => Date.now(),
    after: (delay, fn) => {
      const timer = setTimeout(fn, delay);
      return () => clearTimeout(timer);
    },
    every: (interval, fn) => {
      const timer = setInterval(fn, interval);
      return () => clearInterval(timer);
    },
    sleep: (delay, signal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      }),
  };
}
