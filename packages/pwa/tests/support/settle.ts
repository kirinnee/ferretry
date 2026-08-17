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
 * else. One expired wait in `app.test.tsx` surfaced as three unrelated-looking CI failures for days,
 * two of them in a different describe block, and nothing in the output named a timeout. So running
 * out of budget THROWS, and says what never became true.
 *
 * The budget is WALL CLOCK rather than a turn count, because a turn is not a unit of time: an
 * `act()` flush on a loaded CI runner costs many times what it costs on an idle laptop, so one turn
 * count is a different budget on every machine — which is exactly how a ceiling meant to be
 * "a second" turned out to be 300ms of sleeping.
 *
 * Turns YIELD rather than sleep for as long as yielding is enough — a bare task boundary lets the
 * awaited chain advance as fast as it can, and the common case needs no turn at all — then settle
 * into a small poll, so a slow runner is waited for rather than spun on while it is already short of
 * the CPU the awaited work needs.
 */

/**
 * The wall-clock ceiling on one wait.
 *
 * Measured against the runner's own limit rather than chosen for feel: the unit tier keeps Bun's
 * DEFAULT 5-second per-test timeout (`scripts/ci/test.sh` raises it for the int and sit tiers only),
 * so a wait has to give up well inside that or Bun's own timeout wins the race and takes the
 * diagnostic with it. Two seconds leaves the rest of a test — the mount, the interaction, the
 * assertions, measured at ~700ms on the loaded runners where this failed — its own room inside the
 * same 5 seconds.
 */
const SETTLE_BUDGET_MS = 2_000;

/** Longest one turn sleeps, once yielding alone has stopped being enough. */
const MAX_TURN_DELAY_MS = 5;

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
  budgetMs: number = SETTLE_BUDGET_MS,
): Promise<void> => {
  const started = Date.now();
  let turns = 0;
  while (!ready()) {
    const elapsed = Date.now() - started;
    if (elapsed >= budgetMs)
      throw new Error(
        `waited ${elapsed}ms over ${turns} turns for ${typeof what === 'string' ? what : what()}, which never became true`,
      );
    const delay = Math.min(turns, MAX_TURN_DELAY_MS);
    await flush(async () => {
      await new Promise(resolve => setTimeout(resolve, delay));
    });
    turns += 1;
  }
};
