/**
 * WHEN A TURN HAS ENDED AND ITS REPLY SHOULD BE READ. Pure and total: a small state machine over what the
 * page can see of the session, with no clock and no browser object — the caller says what time it is and
 * how long the conversation has been quiet.
 *
 * THE RULES
 *
 *   1. A reading follows a turn WE SAW: either the daemon's `turnState` was `working` while the page was
 *      open, or this page just sent something (`armOnSend`). A session that is already at `your-turn` when
 *      the page opens, or when the setting is switched on, reads nothing.
 *   2. It fires on the transition to `your-turn` or `needs-input` with `turnStateAt` AFTER the turn began.
 *      The same state seen again (a re-render, an old `your-turn` still showing in the moment after a
 *      send) is not a transition.
 *   3. TEXT-SETTLED GUARD. The last words of a reply and the daemon's whose-turn flip arrive separately and
 *      in either order. It waits until nothing new has arrived for `TEXT_SETTLED_MS` (500 ms), and says how
 *      long to wait (`recheckInMs`) so the caller sets one timer, not a polling loop.
 *   4. OLD DAEMON. One that sends no `turnState` gives only working / not working (the page's own guess).
 *      Then it waits for `LEGACY_QUIET_MS` (3 s) of no new records AND not working. The reading is then
 *      timed by a guess, which the settings page says in words.
 *   5. A session that is not live (finished, parked) ends the watch without a reading.
 */

export const TEXT_SETTLED_MS = 500;
export const LEGACY_QUIET_MS = 3_000;

export type WatchedTurn = 'working' | 'your-turn' | 'needs-input';

export interface TurnWatch {
  /**
   * The turn being waited out: when it began (ms; the daemon's `turnStateAt` once seen, else the moment
   * of our send; null for an old daemon, which dates nothing), or null when no turn is being watched.
   */
  readonly armed: { readonly startedAt: number | null } | null;
}

export const IDLE_WATCH: TurnWatch = Object.freeze({ armed: null });

export interface WatchInput {
  readonly now: number;
  /** Whose turn it is; null for a session that is not live. */
  readonly turn: WatchedTurn | null;
  /** The daemon's `turnStateAt` in ms; null when it sent none. */
  readonly turnAt: number | null;
  /** The daemon sent no `turnState`: `turn` is the page's own working / your-turn guess. */
  readonly legacy: boolean;
  /** Milliseconds since the conversation last changed (a new record, a new turn state). */
  readonly quietMs: number;
}

export interface WatchStep {
  readonly watch: TurnWatch;
  /** Set when the turn has ended and its reply is ready to be picked and read. */
  readonly fire: { readonly startedAt: number | null; readonly outcome: 'your-turn' | 'needs-input' } | null;
  /** When nothing fired only because the conversation was not quiet long enough: ask again in this long. */
  readonly recheckInMs: number | null;
}

const finite = (value: number): boolean => Number.isFinite(value);

/** The person just sent something from this page: the next end of turn is the reply to it. */
export const armOnSend = (watch: TurnWatch, sentAt: number): TurnWatch =>
  watch.armed === null ? { armed: { startedAt: finite(sentAt) ? sentAt : null } } : watch;

/** One look at the session. */
export const observeTurn = (watch: TurnWatch, input: WatchInput): WatchStep => {
  const quiet = (next: TurnWatch): WatchStep => ({ watch: next, fire: null, recheckInMs: null });
  const { turn } = input;
  if (turn === null) return quiet(IDLE_WATCH);

  if (turn === 'working') {
    const seen = input.legacy || input.turnAt === null || !finite(input.turnAt) ? null : input.turnAt;
    // The daemon's own start time replaces a send time on the browser's clock: it is the clock its
    // `your-turn` will be dated by.
    const startedAt = seen ?? watch.armed?.startedAt ?? null;
    return quiet({ armed: { startedAt } });
  }

  if (watch.armed === null) return quiet(watch);

  const { startedAt } = watch.armed;
  if (!input.legacy && input.turnAt !== null && startedAt !== null && !(input.turnAt > startedAt)) {
    // The state it was already in: not the end of the turn we are waiting for.
    return quiet(watch);
  }

  const needed = input.legacy ? LEGACY_QUIET_MS : TEXT_SETTLED_MS;
  if (input.quietMs < needed) {
    return { watch, fire: null, recheckInMs: Math.max(1, Math.ceil(needed - Math.max(0, input.quietMs))) };
  }
  return { watch: IDLE_WATCH, fire: { startedAt, outcome: turn }, recheckInMs: null };
};
