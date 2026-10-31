import type { SendRecord as SendRecordView } from '@ferretry/protocol';

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

const newestFirst = (left: SendRecordView, right: SendRecordView): number =>
  Date.parse(right.acceptedAt) - Date.parse(left.acceptedAt) ||
  (left.sendId < right.sendId ? -1 : left.sendId > right.sendId ? 1 : 0);

/** Thrown for a cursor that names no send of this session. */
export class UnknownSendCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`no send ${cursor} to page from`);
  }
}

/** The page `query` asks for, out of every send of one session in any order. Pure. */
export const sendPage = (sends: readonly SendRecordView[], query: SendPageQuery): SendPage => {
  const ordered = [...sends].sort(newestFirst);
  let start = 0;
  if (query.before !== undefined) {
    const at = ordered.findIndex(send => send.sendId === query.before);
    if (at === -1) throw new UnknownSendCursorError(query.before);
    start = at + 1;
  }
  const page = ordered.slice(start, start + query.limit);
  const last = page.at(-1);
  const nextCursor = last !== undefined && start + page.length < ordered.length ? last.sendId : null;
  if (query.before !== undefined) return { sends: page, nextCursor };
  // The first page also carries every open send past it, in order, so nothing in flight is ever off-page.
  const older = ordered.slice(page.length).filter(isOpenSend);
  return { sends: [...page, ...older], nextCursor };
};
