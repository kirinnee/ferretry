import type { SendRecord as SendRecordView } from '../../seams/protocol.ts';

/**
 * ONE PAGE OF A SESSION'S SENDS, newest first.
 *
 * The ledger is append-only and keeps every send a session ever had: a long-lived lead's was 2,139 sends and
 * 2.3 MB per answer, and a chat page polls it every few seconds — through the relay, on a phone. What a
 * reader needs is what can still move and what sits beside the transcript it is looking at, so a read without
 * a cursor answers the newest {@link DEFAULT_SEND_PAGE} sends and every OPEN one however old, and names a
 * cursor for the rest. An older page is asked for with `before=<that cursor>`.
 *
 * Order is total: acceptance instant, newest first, then id, so a cursor names one place in it for good —
 * the ledger never removes a send, so the id a cursor names is always still there. An open send on the first
 * page appears again on the older page it belongs to; a reader merges pages by id.
 */

/** Sends answered when a read names no limit. */
export const DEFAULT_SEND_PAGE = 100;
/** The most one page may hold. */
export const MAX_SEND_PAGE = 1_000;

export interface SendPageQuery {
  readonly limit: number;
  /** The id the previous page ended on; absent for the first page. */
  readonly before?: string;
}

export interface SendPage {
  readonly sends: readonly SendRecordView[];
  /** Where the next, older page starts; `null` when this page reached the oldest send. */
  readonly nextCursor: string | null;
}

/** Fates no later look can change: a delivered or cancelled send is a final word. */
const FINAL_FATES: ReadonlySet<string> = new Set(['delivered', 'cancelled']);

/**
 * A send whose row a reader must still see wherever it is in the ledger: one in flight or uncertain
 * (accepted, queued, unaccounted, timed out) and one held for a revive. A withdrawn send was never typed.
 */
export const isOpenSend = (send: SendRecordView): boolean =>
  send.withdrawn !== true && (send.held === true || !FINAL_FATES.has(send.fate));

/** How a log's entries are told apart, ordered and judged open: the three facts a window needs. */
export interface WindowKeys<T> {
  readonly id: (item: T) => string;
  /** The instant the item was accepted: the sort key, newest first. */
  readonly at: (item: T) => string;
  /** Whether the item can still move, so a reader must see it wherever it is. */
  readonly open: (item: T) => boolean;
}

/** One window onto an append-only log: the items, newest first, and where the older ones start. */
export interface Window<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * THE WINDOW, owned once: the page `query` asks for out of every item of one session in any order, or
 * `undefined` when its cursor names none of them. The send ledger and the durable queue both read through
 * it, so "the newest page and every open item" cannot drift between the two. Pure and total.
 */
export const windowPage = <T>(all: readonly T[], query: SendPageQuery, keys: WindowKeys<T>): Window<T> | undefined => {
  const ordered = [...all].sort(
    (left, right) =>
      Date.parse(keys.at(right)) - Date.parse(keys.at(left)) ||
      (keys.id(left) < keys.id(right) ? -1 : keys.id(left) > keys.id(right) ? 1 : 0),
  );
  let start = 0;
  if (query.before !== undefined) {
    const at = ordered.findIndex(item => keys.id(item) === query.before);
    if (at === -1) return undefined;
    start = at + 1;
  }
  const page = ordered.slice(start, start + query.limit);
  const last = page.at(-1);
  const nextCursor = last !== undefined && start + page.length < ordered.length ? keys.id(last) : null;
  if (query.before !== undefined) return { items: page, nextCursor };
  // The first page also carries every open item past it, in order, so nothing in flight is ever off-page.
  const older = ordered.slice(page.length).filter(keys.open);
  return { items: [...page, ...older], nextCursor };
};

const SEND_KEYS: WindowKeys<SendRecordView> = {
  id: send => send.sendId,
  at: send => send.acceptedAt,
  open: isOpenSend,
};

/**
 * The page `query` asks for, out of every send of one session in any order; `undefined` when its cursor names
 * no send of this session. Pure and total.
 */
export const sendPage = (sends: readonly SendRecordView[], query: SendPageQuery): SendPage | undefined => {
  const window = windowPage(sends, query, SEND_KEYS);
  return window === undefined ? undefined : { sends: window.items, nextCursor: window.nextCursor };
};
