/** THE LIVE LOOP'S CLOCK over the page's own: monotonic `performance.now()` and `setTimeout`. */

import type { ClockPort } from './ports.ts';

export interface ClockGlobalLike {
  readonly performance: { now(): number };
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: never): void;
}

export function browserClock(global: ClockGlobalLike): ClockPort {
  return {
    now: () => global.performance.now(),
    after: (ms, callback) => {
      const handle = global.setTimeout(callback, Math.max(0, ms));
      return () => global.clearTimeout(handle as never);
    },
  };
}
