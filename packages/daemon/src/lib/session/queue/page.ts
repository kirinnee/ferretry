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
 * A cursor that is a bare id (an older daemon's) falls back to the state at the time of the read.
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

/** `<snapshot instant>~<message id>`: the snapshot is an ISO instant, which holds no `~`. */
const SNAPSHOT_CURSOR = /^(\d{4}-\d{2}-\d{2}T[^~]+)~(.+)$/s;

interface Cursor {
  readonly id: string;
  /** The instant the walk's first page was cut; absent on a bare-id cursor. */
  readonly asOf?: string;
}

const decodeCursor = (cursor: string): Cursor => {
  const match = SNAPSHOT_CURSOR.exec(cursor);
  const asOf = match?.[1];
  const id = match?.[2];
  return asOf !== undefined && id !== undefined && Number.isFinite(Date.parse(asOf)) ? { id, asOf } : { id: cursor };
};

const encodeCursor = (id: string, asOf: string | undefined): string => (asOf === undefined ? id : `${asOf}~${id}`);

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
const carriedByFirstPage = (message: QueuedMessage, asOf: string | undefined): boolean =>
  isOpenMessage(message) ||
  (asOf !== undefined && LEFT_OPEN_INTO.has(message.state) && Date.parse(message.stateAt) > Date.parse(asOf));

/**
 * The page `query` asks for, out of every message of one session in any order; `undefined` when its cursor
 * names no message of this session. Pure and total.
 */
export const queuePage = (messages: readonly QueuedMessage[], query: SendPageQuery): QueuePage | undefined => {
  const cursor = query.before === undefined ? undefined : decodeCursor(query.before);
  const window = windowPage(
    messages,
    cursor === undefined ? { limit: query.limit } : { limit: query.limit, before: cursor.id },
    QUEUE_KEYS,
  );
  if (window === undefined) return undefined;
  // The first page cuts the snapshot its walk is judged against; an older page carries it on.
  const asOf = cursor === undefined ? snapshotOf(messages) : cursor.asOf;
  const nextCursor = window.nextCursor === null ? null : encodeCursor(window.nextCursor, asOf);
  const items =
    cursor === undefined ? window.items : window.items.filter(message => !carriedByFirstPage(message, cursor.asOf));
  return { messages: [...items].reverse(), nextCursor };
};
