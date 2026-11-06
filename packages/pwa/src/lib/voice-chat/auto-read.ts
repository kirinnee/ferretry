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
 *   0. ONLY THE DAEMON'S LIVE WORD COUNTS. A snapshot that is this device's CACHED copy (the fleet's seeded
 *      view, a transcript drawn before the first live read) is not the daemon's word about the session
 *      now: it moves nothing — it is not looked at, raises no watermark and arms nothing. The first LIVE
 *      snapshot seeds the watermark; only later transitions are watched.
 *   1. THE WATERMARK. `seen` is the newest turn-state date this page has looked at, seeded by the FIRST
 *      live snapshot (a session that is already at `your-turn` when the page opens, or when the setting is
 *      switched on, sets the floor and reads nothing). A `working` only starts a watch when it is dated
 *      AFTER everything already seen: a replay of an older working → your-turn pair (a reconnect, a
 *      snapshot arriving late) is at or below the watermark and arms nothing. Whatever is read, skipped or
 *      merely looked at raises it, so consumed is consumed.
 *   2. A WATCHED TURN is one seen `working` after the watermark. Its end is the next `your-turn` or
 *      `needs-input` dated after its `working` — a date that is not later is the state it already had.
 *   3. A SEND IS A TOKEN, TAKEN AT ITS INITIATION. `armOnSend` is called when the person presses send —
 *      before the request is awaited — and remembers the watermark (the FLOOR) and whether a turn was
 *      still in flight (`inFlight`: the newest `working` not yet followed by a completion). The token is
 *      then bound to the SEND'S IDENTITY: the daemon's ledger entry for that send says when the daemon
 *      ACCEPTED it (`boundary`, the daemon's clock). A completion is the send's own only if the daemon
 *      dated it AFTER that acceptance — daemon against daemon, no browser clock — and
 *        - when a `working` of the new turn was seen (after the floor), that `working` is itself dated at
 *          or after the acceptance and the completion after it; or
 *        - when none was seen (a short turn can flip faster than the page renders it), nothing else is
 *          waiting: the turn that was in flight at the press has ended first (its completion is the old
 *          turn's and is consumed).
 *      A previous completion that arrives late is dated before the acceptance; a replayed older `working`
 *      is at or below the floor. With no boundary yet, nothing is read. A newer send REPLACES the token.
 *      THE OLD TURN'S END IS REMEMBERED. Once the completion of the turn that was running at the press has
 *      been consumed (`passedAt`), only a completion dated AFTER it can be the send's own: the same
 *      completion looked at again — its last transcript row arriving, a snapshot replayed — must not pass
 *      just because nothing is "in flight" any more.
 *   4. TEXT-SETTLED GUARD. The last words of a reply and the daemon's whose-turn flip arrive separately and
 *      in either order. It waits until nothing new has arrived for `TEXT_SETTLED_MS` (500 ms), and says how
 *      long to wait (`recheckInMs`) so the caller sets one timer, not a polling loop.
 *   5. HIDDEN IS SILENT, FOR GOOD. A completion that is observed while the tab is hidden is consumed
 *      without a reading, whatever the settle timer says and whenever the person comes back. A send that
 *      cannot yet prove the completion (the ledger has not shown its acceptance) REMEMBERS the date of a
 *      completion seen hidden, and once it can, that completion — and anything dated at or before it — is
 *      consumed silently.
 *   6. A session that is not live (finished, parked) ends the watch without a reading.
 */

export const TEXT_SETTLED_MS = 500;

/**
 * How long a send's finished turn waits for the transcript to show the send's OWN message (and so the rows
 * of its reply) before it gives up and stays silent. A late transcript read is normal; a historical answer
 * read as the reply is never acceptable.
 */
export const EVIDENCE_WAIT_MS = 5_000;

export type WatchedTurn = 'working' | 'your-turn' | 'needs-input';

/** A turn seen `working` while the page was open. */
interface WatchedWork {
  readonly kind: 'watched';
  /** The daemon's date for the start of the turn: a turn nobody here sent has no row of ours to be cut at, so its words are cut by it. */
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
  /** The newest `working` that had no completion yet at the press: the turn already running, whose end is not the reply. */
  readonly inFlight: number | null;
  /** The newest completion date seen while the tab was hidden before this send could be proven: never read. */
  readonly hiddenAt: number | null;
  /**
   * The newest completion date already REJECTED as the end of the turn that was running at the press (it is
   * consumed, never the reply). The send's own completion must be dated AFTER it: the same completion looked
   * at again (its last transcript row arriving, a snapshot replayed) is still the old turn's.
   */
  readonly passedAt?: number | null;
}

type ArmedTurn = WatchedWork | SentWork;

export interface TurnWatch {
  /** The turn being waited out, or null when no turn is being watched. */
  readonly armed: ArmedTurn | null;
  /** The watermark: the newest turn-state date (the daemon's clock) this page has looked at. */
  readonly seen: number | null;
  /** The newest `working` date with no completion after it yet: a turn the page knows is running. */
  readonly busyAt: number | null;
}

export const IDLE_WATCH: TurnWatch = Object.freeze({ armed: null, seen: null, busyAt: null });

export interface WatchInput {
  /**
   * This is the daemon's live word about the session, not this device's cached copy. A cached snapshot is
   * ignored entirely: it arms nothing and raises no watermark.
   */
  readonly authoritative: boolean;
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
}

export interface WatchStep {
  readonly watch: TurnWatch;
  /** Set when the turn has ended and its reply is ready to be picked and read. */
  readonly fire: {
    /** The turn's dated start when it is one this page only watched; null for a send, whose reply is read off the rows. */
    readonly startedAt: number | null;
    readonly outcome: 'your-turn' | 'needs-input';
  } | null;
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
  armed: { kind: 'sent', floor: watch.seen, working: null, inFlight: watch.busyAt, hiddenAt: null },
});

/** The send went nowhere (its request failed): the token is dropped. Anything else being watched stays. */
export const dropSend = (watch: TurnWatch): TurnWatch =>
  watch.armed?.kind === 'sent' ? { ...watch, armed: null } : watch;

/** Stop watching (the setting is off, the session is not ours to read), keeping the watermark. */
export const stopWatching = (watch: TurnWatch): TurnWatch => (watch.armed === null ? watch : { ...watch, armed: null });

/** One look at the session. */
export const observeTurn = (before: TurnWatch, input: WatchInput): WatchStep => {
  const quiet = (next: TurnWatch): WatchStep => ({ watch: next, fire: null, recheckInMs: null });
  // A cached copy is not the daemon's word about the session now: it is not looked at.
  if (!input.authoritative) return quiet(before);
  const { turn, turnAt: at } = input;
  // No date, nothing to be sure of: nothing is watched.
  if (!finite(at)) return quiet(stopWatching(before));
  const first = before.seen === null;
  const fresh = first || at > (before.seen ?? at);
  const watch: TurnWatch = { ...before, seen: newest(before.seen, at) };
  if (turn === null) return quiet(stopWatching({ ...watch, busyAt: null }));
  const { armed } = watch;

  if (turn === 'working') {
    const running: TurnWatch = fresh ? { ...watch, busyAt: at } : watch;
    if (armed === null) {
      // Only a working dated after everything already looked at is a turn that began while the page was open.
      return quiet(fresh ? { ...running, armed: { kind: 'watched', startedAt: at, after: at } } : running);
    }
    if (armed.kind === 'watched')
      return quiet(at > armed.after ? { ...running, armed: { ...armed, after: at } } : running);
    // A send: a working at or before the floor is an earlier turn (or a replay of one).
    const counts = armed.floor === null || at > armed.floor;
    return quiet(counts ? { ...running, armed: { ...armed, working: newest(armed.working, at) } } : running);
  }

  // `your-turn` or `needs-input`: a completion. It ends whatever the page knew to be running before it.
  const ended: TurnWatch = before.busyAt !== null && at > before.busyAt ? { ...watch, busyAt: null } : watch;
  // Only the turn being waited on can be ended by it; the first thing ever seen only sets the floor.
  if (armed === null || (first && armed.kind === 'sent')) return quiet(ended);
  if (armed.kind === 'watched') {
    // The state it was already in is not the end of the turn.
    if (!(at > armed.after)) return quiet(ended);
    // The end of the turn we are waiting for, observed. If nobody is looking it is gone for good.
    if (!input.visible) return quiet(stopWatching(ended));
  } else {
    // A completion seen while hidden is remembered even if it cannot be tied to the send yet.
    const hiddenAt = input.visible ? armed.hiddenAt : newest(armed.hiddenAt, at);
    const noted = (inFlight: number | null, passedAt?: number): TurnWatch => ({
      ...ended,
      armed: { ...armed, inFlight, hiddenAt, ...(passedAt === undefined ? {} : { passedAt }) },
    });
    const { boundary, visible } = input;
    // NO PROOF OF THE SEND'S OWN TURN, NO COMPLETION: it needs the daemon's acceptance of the send and an end
    // the daemon dated after it. A previous turn's completion arriving late is dated before the acceptance.
    if (!finite(boundary) || !(at > boundary)) return quiet(noted(armed.inFlight));
    // The old turn's end, already rejected, looked at again: not newer than what was passed, so not the reply.
    if (armed.passedAt != null && !(at > armed.passedAt)) return quiet(noted(armed.inFlight));
    if (armed.working !== null) {
      // A `working` of the new turn was seen: it must itself be the send's (at or after the acceptance), and the end after it.
      if (armed.working < boundary || !(at > armed.working)) return quiet(noted(armed.inFlight));
    } else if (armed.inFlight !== null) {
      // The turn already running at the press ends first; that end is not the reply.
      return at > armed.inFlight
        ? quiet(noted(null, newest(armed.passedAt ?? null, at)))
        : quiet(noted(armed.inFlight));
    }
    // Proven. Seen hidden — now or before it could be proven — it is gone for good.
    if (!visible || (armed.hiddenAt !== null && at <= armed.hiddenAt)) return quiet(stopWatching(ended));
  }
  const startedAt = armed.kind === 'watched' ? armed.startedAt : null;
  if (input.quietMs < TEXT_SETTLED_MS) {
    return {
      watch: ended,
      fire: null,
      recheckInMs: Math.max(1, Math.ceil(TEXT_SETTLED_MS - Math.max(0, input.quietMs))),
    };
  }
  return { watch: stopWatching(ended), fire: { startedAt, outcome: turn }, recheckInMs: null };
};
