/**
 * WHEN A TURN HAS ENDED AND ITS REPLY SHOULD BE READ. Pure and total: a small state machine over what the
 * page can see of the session, with no clock and no browser object — the caller says how long the
 * conversation has been quiet.
 *
 * IT WORKS ONLY ON THE DAEMON'S OWN WORD. Every date here is the daemon's `turnStateAt`, on the daemon's
 * clock; nothing is ever compared with the browser's clock. A machine that sends no `turnState` gives this
 * nothing to work with, and nothing is auto-read there (the settings page says so in words). There is
 * deliberately no heuristic for it: three reviews in a row found a way for a guess to read history.
 *
 * THE RULES
 *
 *   1. THE WATERMARK. `seen` is the newest turn-state date this page has looked at, seeded by the FIRST
 *      thing it sees (a session that is already at `your-turn` when the page opens, or when the setting is
 *      switched on, sets the floor and reads nothing). A `working` only starts a watch when it is dated
 *      AFTER everything already seen: a replay of an older working → your-turn pair (a reconnect, a
 *      snapshot arriving late) is at or below the watermark and arms nothing. Whatever is read, skipped or
 *      merely looked at raises it, so consumed is consumed.
 *   2. A WATCHED TURN is one seen `working` after the watermark. Its end is the next `your-turn` or
 *      `needs-input` dated after its `working` — a date that is not later is the state it already had.
 *   3. A SEND IS A TOKEN, TAKEN AT ITS INITIATION. `armOnSend` is called when the person presses send —
 *      before the request is awaited — and remembers the watermark (the FLOOR). The token is then bound to
 *      the SEND'S IDENTITY: the daemon's ledger entry for that send says when the daemon ACCEPTED it
 *      (`boundary`, the daemon's clock). The reply to a send is a completion that follows a `working` dated
 *      at or after that boundary — a new turn that began because of the send. Until then every other state
 *      is the old turn: a previous completion that arrives late, a replayed older working, an idle session
 *      at the moment of the press are all dated before the boundary and prove nothing. A user row or a
 *      state that is merely newer than an old snapshot is not evidence. With no boundary yet, nothing is
 *      read. A newer send REPLACES the token.
 *   4. THE PERSON'S OWN ROW. A send is also read only once the person's row (one the page did not hold at
 *      the press) is in the conversation, because the reply is cut at it. If the completion is seen first
 *      the watch waits; it never reads the wrong reply.
 *   5. TEXT-SETTLED GUARD. The last words of a reply and the daemon's whose-turn flip arrive separately and
 *      in either order. It waits until nothing new has arrived for `TEXT_SETTLED_MS` (500 ms), and says how
 *      long to wait (`recheckInMs`) so the caller sets one timer, not a polling loop.
 *   6. HIDDEN IS SILENT, FOR GOOD. A completion that is observed while the tab is hidden is consumed
 *      without a reading, whatever the settle timer says and whenever the person comes back.
 *   7. A session that is not live (finished, parked) ends the watch without a reading.
 */

export const TEXT_SETTLED_MS = 500;

export type WatchedTurn = 'working' | 'your-turn' | 'needs-input';

/** A turn seen `working` while the page was open. */
interface WatchedWork {
  readonly kind: 'watched';
  /** The daemon's date for the start of the turn: the words of the turn are cut by it. */
  readonly startedAt: number;
  /** A completion must be dated after this to be the end of THIS turn (the newest `working` of it). */
  readonly after: number;
}

/** A send from this page, waiting for the turn it starts. */
interface SentWork {
  readonly kind: 'sent';
  /** The newest turn-state date seen at the press (the daemon's clock): a `working` at or before it is an earlier turn. */
  readonly floor: number | null;
  /** The newest `working` seen after the floor; the send's turn if it is dated at or after the acceptance boundary. */
  readonly working: number | null;
}

type ArmedTurn = WatchedWork | SentWork;

export interface TurnWatch {
  /** The turn being waited out, or null when no turn is being watched. */
  readonly armed: ArmedTurn | null;
  /** The watermark: the newest turn-state date (the daemon's clock) this page has looked at. */
  readonly seen: number | null;
}

export const IDLE_WATCH: TurnWatch = Object.freeze({ armed: null, seen: null });

export interface WatchInput {
  /** Whose turn it is; null for a session that is not live. */
  readonly turn: WatchedTurn | null;
  /** The daemon's `turnStateAt` in ms; null when it sent none or none that can be read (nothing is watched). */
  readonly turnAt: number | null;
  /** Milliseconds since the conversation last changed (a new record, a new turn state). */
  readonly quietMs: number;
  /** The tab is in front of the person. A completion observed while it is not is never read. */
  readonly visible: boolean;
  /**
   * When the daemon ACCEPTED the armed send (its ledger entry's `acceptedAt`, the daemon's clock); null
   * while the ledger has not shown it, and when no send is armed.
   */
  readonly boundary: number | null;
  /**
   * The send's own row: a row of the person's that was NOT among the rows held when the armed send was
   * pressed is in the conversation now. False when no send is armed.
   */
  readonly sentRow: boolean;
}

export interface WatchStep {
  readonly watch: TurnWatch;
  /** Set when the turn has ended and its reply is ready to be picked and read. */
  readonly fire: { readonly startedAt: number | null; readonly outcome: 'your-turn' | 'needs-input' } | null;
  /** When nothing fired only because the conversation was not quiet long enough: ask again in this long. */
  readonly recheckInMs: number | null;
}

const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);
const newest = (a: number | null, b: number): number => (a !== null && a > b ? a : b);

/**
 * The person is sending something from this page: the next turn that began because of it is the one to
 * read. Call it when the press happens, not when the request comes back. A send while one is already
 * waited on replaces it.
 */
export const armOnSend = (watch: TurnWatch): TurnWatch => ({
  ...watch,
  armed: { kind: 'sent', floor: watch.seen, working: null },
});

/** The send went nowhere (its request failed): the token is dropped. Anything else being watched stays. */
export const dropSend = (watch: TurnWatch): TurnWatch =>
  watch.armed?.kind === 'sent' ? { ...watch, armed: null } : watch;

/** Stop watching (the setting is off, the session is not ours to read), keeping the watermark. */
export const stopWatching = (watch: TurnWatch): TurnWatch => (watch.armed === null ? watch : { ...watch, armed: null });

/** One look at the session. */
export const observeTurn = (before: TurnWatch, input: WatchInput): WatchStep => {
  const quiet = (next: TurnWatch): WatchStep => ({ watch: next, fire: null, recheckInMs: null });
  const { turn, turnAt: at } = input;
  // No date, nothing to be sure of: nothing is watched.
  if (!finite(at)) return quiet(stopWatching(before));
  const watch: TurnWatch = { ...before, seen: newest(before.seen, at) };
  if (turn === null) return quiet(stopWatching(watch));
  const { armed } = watch;

  if (turn === 'working') {
    if (armed === null) {
      // Only a working dated after everything already looked at is a turn that began while the page was open.
      const fresh = before.seen === null || at > before.seen;
      return quiet(fresh ? { ...watch, armed: { kind: 'watched', startedAt: at, after: at } } : watch);
    }
    if (armed.kind === 'watched') return quiet(at > armed.after ? { ...watch, armed: { ...armed, after: at } } : watch);
    // A send: a working at or before the floor is an earlier turn (or a replay of one).
    const counts = armed.floor === null || at > armed.floor;
    return quiet(counts ? { ...watch, armed: { ...armed, working: newest(armed.working, at) } } : watch);
  }

  // `your-turn` or `needs-input`: a completion. Only the turn being waited on can be ended by it.
  if (armed === null) return quiet(watch);
  let startedAt: number;
  if (armed.kind === 'watched') {
    // The state it was already in is not the end of the turn.
    if (!(at > armed.after)) return quiet(watch);
    startedAt = armed.startedAt;
  } else {
    const { working } = armed;
    // NO PROOF OF THE SEND'S OWN TURN, NO COMPLETION: it needs the daemon's acceptance of the send, a
    // `working` dated at or after it, and an end dated after that working. A previous turn's completion
    // arriving late is dated before all of these and is simply the old turn.
    if (working === null || !finite(input.boundary) || working < input.boundary || !(at > working)) return quiet(watch);
    startedAt = working;
  }

  // The end of the turn we are waiting for, observed. If nobody is looking it is gone for good.
  if (!input.visible) return quiet(stopWatching(watch));
  // The reply is cut at the person's own row; until it shows there is nothing safe to read.
  if (armed.kind === 'sent' && !input.sentRow) return quiet(watch);
  if (input.quietMs < TEXT_SETTLED_MS) {
    return { watch, fire: null, recheckInMs: Math.max(1, Math.ceil(TEXT_SETTLED_MS - Math.max(0, input.quietMs))) };
  }
  return { watch: stopWatching(watch), fire: { startedAt, outcome: turn }, recheckInMs: null };
};
