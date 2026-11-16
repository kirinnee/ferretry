/** The few seams the pure library needs; the daemon half binds each to a kernel port. */
import type { TurnUsage } from '@ferretry/core-ferrets/contract';

/** The wall clock as an ISO instant. */
export interface ClockPort {
  now(): string;
}

/** Runs exclusive work one at a time, in the order it was asked for. */
export interface SerialExecutor {
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}

/** A serial executor over a promise chain. Work that throws rejects its own caller and never blocks the next. */
export function serialExecutor(): SerialExecutor {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    runExclusive<T>(work: () => Promise<T>): Promise<T> {
      const run = tail.then(work, work);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * Where a ferret's turns come from. `undefined` means the harness cannot be asked (none provides a reader, or the read
 * failed): an unreadable ferret is never an empty one, so its spend reads PARTIAL and its insight row reads "unknown".
 */
export interface TurnUsageSource {
  turns(ferret: string, since?: string): Promise<readonly TurnUsage[] | undefined>;
}
