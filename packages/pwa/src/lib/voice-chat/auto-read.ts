/**
 * WHEN A TURN HAS ENDED AND ITS REPLY SHOULD BE READ. Pure and total: a small state machine over what the
 * page can see of the session, with no clock and no browser object — the caller says what time it is and
 * how long the conversation has been quiet.
 *
 * THE RULES
 *
 *   1. A reading follows a turn WE SAW: either the daemon's `turnState` was `working` with a date while the
 *      page was open, or this page just sent something (`armOnSend`). A session that is already at
 *      `your-turn` when the page opens, or when the setting is switched on, reads nothing.
 *   2. A SEND IS A TOKEN, TAKEN AT ITS INITIATION. `armOnSend` is called when the person presses send —
 *      before the request is awaited — and remembers the newest turn state the page had already seen (the
 *      FLOOR). Only a completion dated after that floor is the reply to the send, so a fast turn that ends
 *      before the send is acknowledged is still read, and a snapshot of the previous turn replayed later
 *      is not. A NEWER SEND REPLACES the token: whatever was pending for the older one is dropped.
 *   3. It fires on the transition to `your-turn` or `needs-input` dated AFTER the floor. The same state
 *      seen again (a re-render, an old `your-turn` still showing in the moment after a send) is not a
 *      transition, and a `working` at or before the floor does not move the turn's start.
 *   4. CONSUMED IS CONSUMED. Whatever fires (or is deliberately skipped) moves a per-conversation
 *      WATERMARK to its date: a replay of the same working → your-turn pair after a reconnect arms
 *      nothing and fires nothing.
 *   5. TEXT-SETTLED GUARD. The last words of a reply and the daemon's whose-turn flip arrive separately and
 *      in either order. It waits until nothing new has arrived for `TEXT_SETTLED_MS` (500 ms), and says how
 *      long to wait (`recheckInMs`) so the caller sets one timer, not a polling loop.
 *   6. HIDDEN IS SILENT, FOR GOOD. A completion that is observed while the tab is hidden is consumed
 *      without a reading, whatever the settle timer says and whenever the person comes back.
 *   7. OLD DAEMON. One that sends no `turnState` gives only working / not working (the page's own guess)
 *      and dates nothing. That guess alone proves nothing — an idle old daemon reads as working for one
 *      pane read when the page opens — so it arms a watch only after a SEND, or after the conversation
 *      produced a record the page had not seen at open (`fresh` grows past the last consumed count). Then
 *      it waits for `LEGACY_QUIET_MS` (3 s) of no new records AND not working. The reading is timed by a
 *      guess, which the settings page says in words.
 *   8. A session that is not live (finished, parked) ends the watch without a reading.
 */

export const TEXT_SETTLED_MS = 500;
export const LEGACY_QUIET_MS = 3_000;

export type WatchedTurn = 'working' | 'your-turn' | 'needs-input';

/** A turn being waited out. */
interface ArmedTurn {
  /**
   * When the turn began (ms), for choosing its words by time: the daemon's `turnStateAt` once seen, else
   * the moment of our send on the browser's clock; null for an old daemon, which dates nothing.
   */
  readonly startedAt: number | null;
  /** A completion must be dated AFTER this to be the end of THIS turn. Null: nothing to compare with. */
  readonly after: number | null;
  /**
   * The newest turn state seen when the send was made (the daemon's clock): a `working` at or before it is
   * the turn that was already running, not the reply to the send. Null for a turn seen without a send.
   */
  readonly floor: number | null;
}

export interface TurnWatch {
  /** The turn being waited out, or null when no turn is being watched. */
  readonly armed: ArmedTurn | null;
  /** The newest turn-state date (the daemon's clock) this page has looked at. */
  readonly seen: number | null;
  /** The watermark: the date of the newest turn already read or deliberately skipped, and the legacy record count then. */
  readonly consumed: { readonly at: number | null; readonly fresh: number };
}

export const IDLE_WATCH: TurnWatch = Object.freeze({
  armed: null,
  seen: null,
  consumed: Object.freeze({ at: null, fresh: 0 }),
});

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
  /** The tab is in front of the person. A completion observed while it is not is never read. */
  readonly visible: boolean;
  /**
   * How many records the conversation gained after the page opened (monotonic). Only an old daemon's
   * guess needs it: no new record, no proof that a turn is happening.
   */
  readonly fresh: number;
}

export interface WatchStep {
  readonly watch: TurnWatch;
  /** Set when the turn has ended and its reply is ready to be picked and read. */
  readonly fire: { readonly startedAt: number | null; readonly outcome: 'your-turn' | 'needs-input' } | null;
  /** When nothing fired only because the conversation was not quiet long enough: ask again in this long. */
  readonly recheckInMs: number | null;
}

const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);
const newest = (a: number | null, b: number | null): number | null => {
  if (!finite(a)) return finite(b) ? b : null;
  return finite(b) ? Math.max(a, b) : a;
};

/**
 * The person is sending something from this page: the next end of turn is the reply to it. Call it when
 * the press happens, not when the request comes back. A send while one is already waited on replaces it.
 */
export const armOnSend = (watch: TurnWatch, sentAt: number): TurnWatch => {
  const floor = newest(watch.seen, watch.consumed.at);
  const at = finite(sentAt) ? sentAt : null;
  return { ...watch, armed: { startedAt: at, after: floor ?? at, floor } };
};

const consume = (watch: TurnWatch, input: WatchInput): TurnWatch => ({
  armed: null,
  seen: watch.seen,
  consumed: { at: newest(watch.consumed.at, input.turnAt), fresh: Math.max(watch.consumed.fresh, input.fresh) },
});

/** One look at the session. */
export const observeTurn = (before: TurnWatch, input: WatchInput): WatchStep => {
  const watch: TurnWatch =
    finite(input.turnAt) && !input.legacy ? { ...before, seen: newest(before.seen, input.turnAt) } : before;
  const quiet = (next: TurnWatch): WatchStep => ({ watch: next, fire: null, recheckInMs: null });
  const { turn } = input;
  const at = input.legacy || !finite(input.turnAt) ? null : input.turnAt;
  if (turn === null) return quiet({ ...watch, armed: null });

  if (turn === 'working') {
    const { armed } = watch;
    if (armed !== null) {
      // The daemon's own start time replaces a send time on the browser's clock: it is the clock its
      // `your-turn` will be dated by. A `working` at or before the floor is the turn that was already
      // running when the person sent, so it cannot move the start.
      if (at === null || (armed.floor !== null && !(at > armed.floor))) return quiet(watch);
      return quiet({ ...watch, armed: { ...armed, startedAt: at, after: at } });
    }
    if (input.legacy) {
      // The page's own guess proves nothing by itself: a new record must have come since the last reading.
      return input.fresh > watch.consumed.fresh
        ? quiet({ ...watch, armed: { startedAt: null, after: null, floor: null } })
        : quiet(watch);
    }
    if (at === null || (watch.consumed.at !== null && !(at > watch.consumed.at))) return quiet(watch);
    return quiet({ ...watch, armed: { startedAt: at, after: at, floor: null } });
  }

  if (watch.armed === null) return quiet(watch);

  const { startedAt, after } = watch.armed;
  if (!input.legacy && at !== null && after !== null && !(at > after)) {
    // The state it was already in: not the end of the turn we are waiting for.
    return quiet(watch);
  }

  // The end of the turn we are waiting for, observed. If nobody is looking it is gone for good.
  if (!input.visible) return quiet(consume(watch, input));

  const needed = input.legacy ? LEGACY_QUIET_MS : TEXT_SETTLED_MS;
  if (input.quietMs < needed) {
    return { watch, fire: null, recheckInMs: Math.max(1, Math.ceil(needed - Math.max(0, input.quietMs))) };
  }
  return { watch: consume(watch, input), fire: { startedAt, outcome: turn }, recheckInMs: null };
};
