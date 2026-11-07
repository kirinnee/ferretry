import type { MonotonicClockPort } from '../../../lib/session/health/types.ts';

/**
 * Elapsed time from the runtime's monotonic source.
 *
 * `performance.now()` is not affected by NTP steps or by the operator setting the clock, which is
 * exactly why the self-check gap is measured with it: a wall-clock gap cannot tell a starved event
 * loop from a time adjustment, and both directions of that confusion cost real work.
 */
export class SystemMonotonicClock implements MonotonicClockPort {
  elapsedMs(): number {
    return performance.now();
  }
}
