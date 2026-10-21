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

/** What the gate reads and says. `midTurn` answers 0 when the daemon cannot tell. */
export interface MidTurnGate {
  midTurn(): Promise<number>;
  sleep(milliseconds: number): Promise<void>;
  warn(line: string): void;
}

/** "one ferret is" / "3 ferrets are". */
const ferretsAre = (count: number): string => (count === 1 ? 'one ferret is' : `${String(count)} ferrets are`);

/** The one line a restart with ferrets mid-turn says. */
const keepRunningNote = (count: number): string =>
  `${ferretsAre(count)} mid-turn; ${count === 1 ? 'it keeps' : 'they keep'} running through the restart, and Ferretry calls made meanwhile wait for the daemon to come back`;

/**
 * Before a restart: say that ferrets keep running, or — asked to — wait until none is mid-turn.
 * `act` names what waits, as in "waiting until every ferret is idle before updating".
 */
export async function passMidTurn(gate: MidTurnGate, whenIdle: boolean, act: string): Promise<void> {
  let count = await gate.midTurn();
  if (count === 0) return;
  if (!whenIdle) {
    gate.warn(keepRunningNote(count));
    return;
  }
  gate.warn(`${ferretsAre(count)} mid-turn; waiting until every ferret is idle before ${act}`);
  while (count > 0) {
    await gate.sleep(MID_TURN_POLL_MS);
    count = await gate.midTurn();
  }
}
