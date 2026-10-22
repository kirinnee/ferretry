/**
 * HOW LONG ONE MACHINE MAY KEEP EVERYONE WAITING.
 *
 * A machine that never answers is the one failure a per-machine fan-out cannot see by itself: a rejected
 * read settles and is reported, but a read that hangs — a sleeping daemon behind a relay edge that still
 * answers keepalives, a request parked behind another machine's unlock — never settles at all. Anything
 * that waits for every machine (a merged answer, a loop over machines, a "loading" that clears when the
 * last read lands) then waits for that one forever, and the healthy machines wait with it.
 *
 * So every multi-machine read bounds each machine on its own: past the deadline that machine's read is
 * a failure like any other — "did not answer within 20s" — and the rest carry on. The read itself is not
 * cancelled here (its owner holds the transport and may still use a late answer); only the waiting stops.
 */

import type { ReadSender } from './shared-reads.ts';

/** The timer, injected so no suite waits on a real clock. Returns how to cancel the run. */
export type DeadlineSchedule = (run: () => void, delayMs: number) => () => void;

export const realSchedule: DeadlineSchedule = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  return () => clearTimeout(handle);
};

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

/**
 * A read sender whose plain reads (GET and HEAD) give up after `deadlineMs` when the caller set no
 * signal of its own. The projects, attention and usage stores read through one coalescing sender with
 * no deadline, so a quiet machine left each of their per-machine single-flight slots "loading" until
 * its relay session died. A caller that passes a signal keeps its own; writes are never cut short.
 */
export const boundedReads =
  (
    send: ReadSender,
    deadlineMs: number = MACHINE_READ_DEADLINE_MS,
    timeout: (ms: number) => AbortSignal = ms => AbortSignal.timeout(ms),
  ): ReadSender =>
  (input, init = {}) => {
    // A `Request` carries its own signal, which an init signal would replace: it passes through as is.
    if (input instanceof Request || init.signal != null) return send(input, init);
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return send(input, init);
    return send(input, { ...init, signal: timeout(deadlineMs) });
  };
