import type { QueuedMessage } from '@ferretry/protocol';
import { type SendPageQuery, windowPage } from '../send/page.ts';

/**
 * ONE PAGE OF A SESSION'S QUEUE, answered the way the send ledger is (`session/send/page.ts`).
 *
 * The queue log is append-only and keeps every message a session ever had: a long-lived lead's was 2,948
 * messages (3.5 MB of log, 2.2 MB per answer) of which 14 were waiting, and the app read it 16 times in an
 * 18-second start-up. A reader needs what can still move and what sits beside the transcript it is looking
 * at, so a read without a cursor answers the newest page and every OPEN message however old — exactly the
 * window `GET …/sends` answers, because it is the same function — and names a cursor for the rest. An older
 * page is asked for with `before=<that cursor>`.
 *
 * A WALK MEETS EVERY MESSAGE ONCE, EVEN ONE THAT CHANGES STATE MID-WALK. The first page carries every open
 * message older than itself, so an older page must leave those out — but "open" is a state, and a state moves:
 * judged by the state at the time of the older read, a message the first page carried and somebody then
 * cancelled would be answered a second time, and one that finished would come back as if it were new. So the
 * cursor names a SNAPSHOT as well as a place: `<instant>~<id>`, the instant being the newest the first page's
 * messages show. A message that stands in a state only an open message can have just left (`delivered`,
 * `cancelled`, `failed`) at a `stateAt` after that instant was open when the first page was cut, so it was
 * carried, so it is left out. The one move this cannot read is `unconfirmed` → `read` — it reaches the same
 * final state as `delivered` → `read` — and it is answered rather than left out: the cost is that rare
 * message twice, never a gap, and a reader merges a repeated id by its fresher revision/state anyway.
 * A cursor is ALWAYS this opaque form, never a bare message id: message ids are chosen by the sender, so a bare id
 * could be spelled exactly like another session's cursor and slip past the binding below. The paged read is new, so no
 * client holds a bare-id cursor; anything that does not decode, names another session or was not cut from this
 * queue is refused.
 *
 * The messages of a page are answered OLDEST FIRST, as the whole queue always was, so a reader written
 * against the unpaged answer reads this one unchanged — it only sees fewer messages.
 */

/**
 * A message that can still move: waiting, being typed, or typed and unproven. A delivered message's only
 * remaining move is the cosmetic fourth tick (`read`), which the send ledger's own delivered row already
 * stands in for, so it is not held on the first page; `read`, `cancelled` and `failed` are final.
 */
export const isOpenMessage = (message: QueuedMessage): boolean =>
  message.state === 'queued' || message.state === 'typing' || message.state === 'unconfirmed';

export interface QueuePage {
  /** The window's messages, oldest first. */
  readonly messages: readonly QueuedMessage[];
  /** Where the next, older page starts; `null` when this page reached the oldest message. */
  readonly nextCursor: string | null;
}

const QUEUE_KEYS = {
  id: (message: QueuedMessage): string => message.id,
  at: (message: QueuedMessage): string => message.enqueuedAt,
  open: isOpenMessage,
};

/**
 * `<snapshot instant>~<session>~<message id>`: the snapshot is an ISO instant, which holds no `~`, and the session
 * and the id are percent-escaped (with `~` too) so neither can hold one.
 */
const SNAPSHOT_CURSOR = /^(\d{4}-\d{2}-\d{2}T[^~]+)~([^~]+)~([^~]+)$/;

interface Cursor {
  readonly id: string;
  /** The instant the walk's first page was cut. */
  readonly asOf: string;
}

const escapePart = (part: string): string => encodeURIComponent(part).replaceAll('~', '%7E');

const unescapePart = (part: string): string | undefined => {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
};

/**
 * What a cursor says, or `undefined` when it is not a snapshot cursor of THIS session: not shaped as one, badly escaped,
 * naming another session, or an unreadable instant. There is no bare-id reading to fall back to.
 */
const decodeCursor = (cursor: string, session: string): Cursor | undefined => {
  const match = SNAPSHOT_CURSOR.exec(cursor);
  const asOf = match?.[1];
  const from = match?.[2] === undefined ? undefined : unescapePart(match[2]);
  const id = match?.[3] === undefined ? undefined : unescapePart(match[3]);
  return asOf !== undefined && id !== undefined && from === session && Number.isFinite(Date.parse(asOf))
    ? { id, asOf }
    : undefined;
};

const encodeCursor = (session: string, id: string, asOf: string): string =>
  `${asOf}~${escapePart(session)}~${escapePart(id)}`;

/** The newest instant any message shows: what the first page of a walk can say it saw. */
const snapshotOf = (messages: readonly QueuedMessage[]): string | undefined => {
  let newest: string | undefined;
  for (const message of messages)
    for (const instant of [message.enqueuedAt, message.stateAt])
      if (newest === undefined || Date.parse(instant) > Date.parse(newest)) newest = instant;
  return newest;
};

/** States an open message leaves into: reaching one after the snapshot means it was open at the snapshot. */
const LEFT_OPEN_INTO: ReadonlySet<string> = new Set(['delivered', 'cancelled', 'failed']);

/** Whether the first page of the walk cut at `asOf` carried this message, so an older page must not. */
const carriedByFirstPage = (message: QueuedMessage, asOf: string): boolean =>
  isOpenMessage(message) || (LEFT_OPEN_INTO.has(message.state) && Date.parse(message.stateAt) > Date.parse(asOf));

/**
 * Whether a snapshot can be one this session's walk was cut at. The log only grows, so a snapshot is never later than
 * the newest instant it shows now, and the first page that cut it carried the message the cursor names, so it is not
 * earlier than that message's enqueue. Anything else was not made here — a forged cursor, or one of another log.
 */
const snapshotFits = (messages: readonly QueuedMessage[], cursor: Cursor): boolean => {
  const named = messages.find(message => message.id === cursor.id);
  const newest = snapshotOf(messages);
  if (named === undefined || newest === undefined) return true;
  const at = Date.parse(cursor.asOf);
  return at <= Date.parse(newest) && at >= Date.parse(named.enqueuedAt);
};

/**
 * The page `query` asks for, out of every message of `session` in any order; `undefined` when its cursor names no
 * message of it, or is a snapshot cursor that was not cut from this session's queue. Pure and total.
 */
export const queuePage = (
  messages: readonly QueuedMessage[],
  query: SendPageQuery,
  session: string,
): QueuePage | undefined => {
  const cursor = query.before === undefined ? undefined : decodeCursor(query.before, session);
  if (query.before !== undefined && (cursor === undefined || !snapshotFits(messages, cursor))) return undefined;
  const window = windowPage(
    messages,
    cursor === undefined ? { limit: query.limit } : { limit: query.limit, before: cursor.id },
    QUEUE_KEYS,
  );
  if (window === undefined) return undefined;
  // The first page cuts the snapshot its walk is judged against; an older page carries it on.
  const asOf = cursor === undefined ? snapshotOf(messages) : cursor.asOf;
  const nextCursor =
    window.nextCursor === null || asOf === undefined ? null : encodeCursor(session, window.nextCursor, asOf);
  const items =
    cursor === undefined ? window.items : window.items.filter(message => !carriedByFirstPage(message, cursor.asOf));
  return { messages: [...items].reverse(), nextCursor };
};
