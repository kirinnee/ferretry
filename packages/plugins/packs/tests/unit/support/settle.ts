/**
 * ONE BOUNDED WAIT, AND IT FAILS OUT LOUD: a surface whose effects cross real task boundaries (a dynamic `import()`, a
 * timer) is waited on by condition, with a ceiling, and running out of turns THROWS naming what never became true instead
 * of returning as if satisfied. `flush` is the harness's own `act` wrapper (`interact` from `./dom.ts`).
 */
const SETTLE_TURNS = 1_500;

const turn = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
};

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
