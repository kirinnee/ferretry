import { ShellError } from '../errors.ts';

/**
 * FERRETS MID-TURN NO LONGER BLOCK A RESTART (`docs/updating.md` § Ferrets keep running).
 *
 * A ferret runs in tmux, outside the daemon, and the new daemon adopts its pane again; its Ferretry
 * calls wait for the daemon to come back instead of failing (`daemon-restart.ts`). So `fy daemon
 * update` and `fy daemon restart` go ahead with one line saying so, and `--when-idle` is still there
 * for whoever would rather wait for every turn to end.
 */

/** How often `--when-idle` looks again for the last ferret to finish its turn. */
const MID_TURN_POLL_MS = 5_000;

/**
 * What the gate reads and says. `midTurn` answers how many ferrets are mid-turn, answers 0 when the daemon is down
 * (nothing to wait for), and throws {@link MidTurnUnreadableError} when the daemon answers but the count cannot be read.
 */
export interface MidTurnGate {
  midTurn(): Promise<number>;
  sleep(milliseconds: number): Promise<void>;
  warn(line: string): void;
}

/** The daemon is up and the mid-turn count could not be read (a timeout, a refused credential, a missing route, a shape this fy does not read). */
export class MidTurnUnreadableError extends Error {
  override readonly name = 'MidTurnUnreadableError';
}

/** "one ferret is" / "3 ferrets are". */
const ferretsAre = (count: number): string => (count === 1 ? 'one ferret is' : `${String(count)} ferrets are`);

/** The one line a restart with ferrets mid-turn says. */
const keepRunningNote = (count: number): string =>
  `${ferretsAre(count)} mid-turn; ${count === 1 ? 'it keeps' : 'they keep'} running through the restart, and Ferretry calls made meanwhile wait for the daemon to come back`;

/** What `--when-idle` said it would do, and so what was NOT done when it could not tell. */
const NOT_DONE = { restarting: 'restarted', updating: 'updated' } as const;

/**
 * Before a restart: say that ferrets keep running, or — asked to — wait until none is mid-turn.
 * `act` names what waits, as in "waiting until every ferret is idle before updating".
 *
 * FAIL CLOSED WITH `--when-idle`: a person who asked to wait for idle must not get a restart because the count could
 * not be read, so an unreadable count with the daemon up refuses (the sentence says nothing was done and how to go
 * on). Without it the count is only for the line above, and an unreadable one is the same as none.
 */
export async function passMidTurn(gate: MidTurnGate, whenIdle: boolean, act: keyof typeof NOT_DONE): Promise<void> {
  const read = async (): Promise<number> => {
    try {
      return await gate.midTurn();
    } catch (error) {
      if (!(error instanceof MidTurnUnreadableError)) throw error;
      if (!whenIdle) return 0;
      throw new ShellError(
        `could not read how many ferrets are mid-turn, so nothing was ${NOT_DONE[act]}; run it again, or leave out --when-idle to go ahead without waiting`,
      );
    }
  };
  let count = await read();
  if (count === 0) {
    if (whenIdle) gate.warn('no ferret is mid-turn');
    return;
  }
  if (!whenIdle) {
    gate.warn(keepRunningNote(count));
    return;
  }
  gate.warn(`${ferretsAre(count)} mid-turn; waiting until every ferret is idle before ${act}`);
  while (count > 0) {
    await gate.sleep(MID_TURN_POLL_MS);
    count = await read();
  }
}
