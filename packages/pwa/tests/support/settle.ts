import { unitClock } from '../../../daemon/tests/support/unit-clock.ts';

/**
 * ONE BOUNDED WAIT FOR THE WHOLE PACKAGE, AND IT FAILS OUT LOUD.
 *
 * A surface whose effects cross REAL task boundaries — a dynamic `import()`, a debounced fetch, a
 * MutationObserver callback — is not settled by flushing microtasks, so a test has to wait for the
 * condition it is actually about. Waiting needs a ceiling, or a genuine regression hangs the runner
 * instead of failing it.
 *
 * The ceiling is what every hand-rolled copy of this got wrong. A loop written
 * `for (turn = 0; turn < turns && !ready(); turn += 1)` RETURNS AS IF SATISFIED when it runs out of
 * turns: the next assertion then reports the value that never arrived, so an expired wait presents
 * as a missing entry — the damaged-state-as-empty-state pattern this codebase refuses everywhere
 * else. The expired wait in `app.test.tsx` spent days reported as an absent terminal stream ticket,
 * in a CI run whose other two failures had an entirely different cause — and because nothing in the
 * output named a timeout, all three read as one unexplained flake and blocked every PR in the
 * repository. Making it speak was what separated them. So running out of budget THROWS, and says what
 * never became true.
 *
 * The budget used to be WALL CLOCK, and that was the flake: on a loaded runner the awaited work and
 * the budget raced. The unit tier now has no wall clock at all (`unit-determinism.ts`): what the
 * awaited code schedules on a timer happens in virtual time, in order, whatever the machine's speed,
 * so the only thing left to bound is how many real turns the wait spins — see {@link SETTLE_TURNS}.
 */

/**
 * The ceiling on one wait, in TURNS of the event loop — not milliseconds.
 *
 * The unit tier has no wall clock: `packages/daemon/tests/support/unit-determinism.ts` freezes time, so
 * a budget read off `Date.now()` would never run out, and a sleep of even 1 ms would wait on a clock
 * nothing moves. A turn is a real zero-delay task boundary, which still lets work the test does not
 * schedule — WebCrypto, a dynamic `import()`, a file read — finish off the JavaScript thread. Each turn is
 * `unitClock.turn()`, which the virtual clock does not count as work in hand, so a timer the awaited
 * code set (a poll, a debounce) still fires on idle, in order, while this waits.
 *
 * Only IDLE turns count — a turn taken while WebCrypto or a file read is still in flight is the
 * machine's speed, not the wait's — so the ceiling is the same on every machine: 1,500 turns in which
 * nothing was left to happen means nothing is going to.
 */
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
      throw new Error(
        `waited ${turns} turns for ${typeof what === 'string' ? what : what()}, which never became true — a wait on a timer needs unitClock.advance(ms)`,
      );
    await flush(() => unitClock.turn());
    // A turn spent while tracked off-thread work is still in flight is the machine's speed, not the
    // wait's: only idle turns count toward the ceiling.
    if (!unitClock.busy) turns += 1;
  }
};
