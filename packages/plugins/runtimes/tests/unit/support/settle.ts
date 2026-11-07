import { setImmediate } from 'node:timers';

/** Bound asynchronous test-renderer work in event-loop turns, and fail if the condition never holds. */
const SETTLE_TURNS = 1_500;

/**
 * Waits for `ready`, inside the caller's own `act` wrapper, and fails naming `what` if it never
 * holds.
 *
 * `flush` is a required argument rather than a default because the two React harnesses in this
 * package are genuinely different: happy-dom suites pass `interact` from `./dom.ts`, test-renderer
 * suites pass `runAsync` from `./react.ts`. Defaulting to either would drag that harness's global
 * registration into every suite that imported this one.
 *
 * `what` may be a FUNCTION, evaluated only when the budget runs out. A condition that failed is the
 * one moment the surrounding state is worth reading, and the whole point of this helper is that the
 * expiry explains itself: "the socket never opened" is a symptom, "the socket never opened and the
 * daemon was never even asked for the terminal list" is a diagnosis. Nothing is computed on the happy
 * path.
 */
export const settleUntil = async (
  ready: () => boolean,
  what: string | (() => string),
  flush: (callback: () => Promise<void>) => Promise<void>,
  maxTurns: number = SETTLE_TURNS,
): Promise<void> => {
  let turns = 0;
  while (!ready()) {
    if (turns >= maxTurns)
      throw new Error(`waited ${turns} turns for ${typeof what === 'string' ? what : what()}, which never became true`);
    await flush(() => new Promise<void>(resolve => setImmediate(resolve)));
    turns += 1;
  }
};
