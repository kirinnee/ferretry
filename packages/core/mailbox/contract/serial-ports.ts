/** The two small ports the ported send, queue, question and turn code stands on: a clock and a serial executor. */

import type { Instant } from '@ferretry/std';

export interface ClockPort {
  now(): Instant;
}

export interface SerialExecutor {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * A {@link SerialExecutor} that can also queue exclusive work BEHIND keyed work.
 *
 * `runExclusiveYielding` is exclusive once it runs, exactly as `runExclusive` is, but while it only waits
 * it holds no barrier: keyed work queued after it still runs first. It is for read-side reconciliation —
 * a live feed's backlog proof — which must never make a ferret's write wait for a pass that has not
 * started yet.
 */
export interface YieldingSerialExecutor extends SerialExecutor {
  runExclusiveYielding<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Keyed work that holds SEVERAL keys at once: it starts when every named key's queue (and any exclusive pass) ahead
   * of it has drained, and keeps all of them until `work` settles. The keys are claimed in one synchronous step, so
   * two callers naming the same keys in a different order cannot wait on each other, and a pass that is already
   * waiting for the first key cannot be waited on by the second (which a nested `run` inside `run` would do).
   */
  runAcross<T>(keys: readonly string[], work: () => Promise<T>): Promise<T>;
}
