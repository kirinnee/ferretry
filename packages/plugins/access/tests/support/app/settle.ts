/**
 * ONE BOUNDED WAIT, AND IT FAILS OUT LOUD (copy of today's `pwa/tests/support/settle.ts`).
 *
 * Today's copy spun `unitClock.turn()` from the daemon's unit-determinism preload, which froze wall-clock time
 * for the whole unit tier. This package has no such preload yet, so a turn here is one real zero-delay task
 * boundary. The rule is unchanged: running out of turns THROWS and names what never became true, so an expired
 * wait never presents as a missing value.
 */

const SETTLE_TURNS = 1_500;

const turn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Waits for `ready`, inside the caller's own `act` wrapper, and fails naming `what` if it never holds. */
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
