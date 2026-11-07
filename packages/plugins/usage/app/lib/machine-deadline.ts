/**
 * HOW LONG ONE MACHINE MAY KEEP EVERYONE WAITING.
 *
 * A machine that never answers is the one failure a per-machine fan-out cannot see by itself: a rejected
 * read settles and is reported, but a read that hangs never settles at all. Anything that waits for every
 * machine (a merged answer, a "loading" that clears when the last read lands) then waits for that one
 * forever, and the healthy machines wait with it.
 *
 * So every multi-machine read bounds each machine on its own: past the deadline that machine's read is
 * a failure like any other — "did not answer within 20s" — and the rest carry on. The read itself is not
 * cancelled here; only the waiting stops.
 */

import { browserClock } from '../shell.ts';

/** The timer, injected so no suite waits on a real clock. Returns how to cancel the run. */
export type DeadlineSchedule = (run: () => void, delayMs: number) => () => void;

export const realSchedule: DeadlineSchedule = (run, delayMs) => browserClock.after(run, delayMs);

/** A machine-wide default: long enough for a cold relay dial, short enough that nobody waits on a corpse. */
export const MACHINE_READ_DEADLINE_MS = 20_000;

/** The reason a read gave up waiting. Its message is the plain one a status line can show. */
export class MachineDeadlineError extends Error {
  readonly deadlineMs: number;
  constructor(deadlineMs: number) {
    super(`did not answer within ${Math.round(deadlineMs / 1000)}s`);
    this.name = 'MachineDeadlineError';
    this.deadlineMs = deadlineMs;
  }
}

/**
 * `read`, or a {@link MachineDeadlineError} once `deadlineMs` has passed — whichever comes first. A late
 * settlement of `read` is swallowed here so it is never an unhandled rejection.
 *
 * The deadline's own rejection is also marked handled as it is made. It fires from a timer, and a CI run
 * under fake timers reported it as unhandled though every caller catches it; the caller still receives it.
 */
export const withDeadline = <T>(
  read: Promise<T>,
  deadlineMs: number = MACHINE_READ_DEADLINE_MS,
  schedule: DeadlineSchedule = realSchedule,
): Promise<T> => {
  const bounded = new Promise<T>((resolve, reject) => {
    const cancel = schedule(() => reject(new MachineDeadlineError(deadlineMs)), deadlineMs);
    read.then(
      value => {
        cancel();
        resolve(value);
      },
      (cause: unknown) => {
        cancel();
        reject(cause);
      },
    );
  });
  bounded.catch(() => undefined);
  return bounded;
};
