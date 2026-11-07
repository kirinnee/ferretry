/**
 * ONE BOUNDED WAIT FOR THE WHOLE SUITE, AND IT FAILS OUT LOUD.
 *
 * A surface whose effects cross REAL task boundaries — a dynamic `import()`, a debounced fetch — is not settled by
 * flushing microtasks, so a test waits for the condition it is actually about. Waiting needs a ceiling, or a genuine
 * regression hangs the runner instead of failing it; and running out of budget THROWS and says what never became
 * true, because a loop that returns as if satisfied presents an expired wait as a missing value.
 *
 * `flush` is required rather than defaulted because the two React harnesses are genuinely different: happy-dom
 * suites pass `interact` from `./dom.ts`, test-renderer suites pass `runAsync` from `./react.ts`.
 */

/** The ceiling on one wait, in TURNS of the event loop. */
const SETTLE_TURNS = 1_500;

const turn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

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
    await flush(turn);
    turns += 1;
  }
};
