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
 * An older page leaves out the open messages (the first page carried them already), so a walk that starts at the
 * first page meets every message exactly once.
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
 * The page `query` asks for, out of every message of one session in any order; `undefined` when its cursor
 * names no message of this session. Pure and total.
 */
export const queuePage = (messages: readonly QueuedMessage[], query: SendPageQuery): QueuePage | undefined => {
  const window = windowPage(messages, query, QUEUE_KEYS);
  if (window === undefined) return undefined;
  // The first page carried every open message already, so an older page leaves them out: a walk that starts
  // at the first page meets each message once. The cursor still names the last message the page spanned.
  const items = query.before === undefined ? window.items : window.items.filter(message => !isOpenMessage(message));
  return { messages: [...items].reverse(), nextCursor: window.nextCursor };
};
