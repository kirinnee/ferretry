/**
 * A PAGE OF OLDER HISTORY: the newest events that sit before a byte of a session's transcript.
 *
 * The chat used to read the newest events of a session and nothing else, so in a long conversation the
 * reader scrolled up into a wall — whatever was older than one tail could not be reached at all. A page
 * is the tail's mirror image: where a tail ends at the end of the file, a page ends at a byte the caller
 * names (`before`), which is where the history it already holds begins. Asking again with the page's
 * own `start` reads the page before that one, until `start` is `0` and the conversation is whole.
 *
 * COORDINATES ARE RECORD BOUNDARIES. A page never begins inside a record: the events of one record — a
 * Claude message with thinking, text and a tool call, say — are kept or dropped together. So two pages
 * that meet at a `start` share no record and miss none, and the client can lay them end to end.
 *
 * WHAT IT COSTS. The bytes the page covers, read forward through a window that stops at `before` (see
 * `TranscriptWindowOptions.end`), never the file. A page starts small and widens towards its scan
 * bound only while it has found fewer events than it was asked for, exactly as a tail does; a stretch
 * of the file with nothing to show — one pasted screenshot, a run of bookkeeping records — is stepped
 * over by `start` moving back the whole scan, so the next page always begins further back.
 */

import type { TranscriptBatch, TranscriptEvent, TranscriptSource } from '../../transcript/types.ts';

/** The windows a page tries, from its end backwards, before the last one ({@link MAX_LOG_PAGE_SCAN_BYTES}). */
export const LOG_PAGE_GROWTH_BYTES: readonly number[] = [512 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024];

/**
 * The furthest back from its end one page reads.
 *
 * It is the per-record bound (`DEFAULT_MAX_PENDING_BYTES`), so any record the source can parse at all
 * fits inside one page's scan, and a page that found nothing in it hands back a `start` that far back.
 */
export const MAX_LOG_PAGE_SCAN_BYTES = 64 * 1024 * 1024;

/** The steps one page window may take: a scan of {@link MAX_LOG_PAGE_SCAN_BYTES} in 8 MiB steps, with room. */
const PAGE_STEP_LIMIT = 64;

/** Which bytes a page may come from, and how many events it holds. */
export interface TranscriptPageRange {
  /** The lowest byte the page may read from — `0` for "anywhere older". */
  readonly from: number;
  /** The byte the page ends BEFORE: where the history the caller already holds begins. */
  readonly before: number;
  readonly limit: number;
}

/** A page: its events, oldest first, and the record boundary it begins at. */
export interface TranscriptPage {
  readonly events: readonly TranscriptEvent[];
  /**
   * Where the page begins, which is where the page before it ends. Always a record boundary or the
   * page's `from`, and always below `before` unless `before` was already at `from`.
   */
  readonly start: number;
}

/**
 * The newest `limit` events of `events`, widened back to the start of the record the cut fell in, and
 * whether anything was dropped. Every event of one record carries that record's byte offset, and a
 * record's events are contiguous, so a cut moved back over equal offsets never splits a record.
 */
export function newestWholeRecords(
  events: readonly TranscriptEvent[],
  limit: number,
): { readonly events: readonly TranscriptEvent[]; readonly trimmed: boolean } {
  if (events.length <= limit) return { events, trimmed: false };
  let cut = events.length - limit;
  while (cut > 0 && sameRecord(events[cut - 1], events[cut])) cut -= 1;
  return { events: cut === 0 ? events : events.slice(cut), trimmed: cut > 0 };
}

const sameRecord = (left: TranscriptEvent | undefined, right: TranscriptEvent | undefined): boolean =>
  left?.byteOffset !== undefined && left.byteOffset === right?.byteOffset;

/**
 * A tail as the first page of a chat: its events from a record boundary on, and that boundary.
 *
 * A tail of exactly `limit` events may have been cut inside its first record, so that record is left to
 * the page before — which holds it whole — rather than shown in part and then again in full. A tail
 * that held fewer than `limit` events began at the start of the file or at its byte bound; either way its
 * first event's record is where it begins. A tail with no events at all begins at `size`, the end of the
 * file, so the page before it is "everything".
 *
 * `undefined` when the whole tail is ONE record that may have been cut: there is no boundary inside it
 * to begin at, so the caller reads the page before `size` instead, which keeps that record whole.
 */
export function tailPage(events: readonly TranscriptEvent[], limit: number, size: number): TranscriptPage | undefined {
  const first = events[0];
  if (first === undefined) return { events, start: size };
  if (events.length < limit) return { events, start: first.byteOffset ?? 0 };
  let cut = 0;
  while (cut < events.length && sameRecord(first, events[cut])) cut += 1;
  if (cut === events.length) return undefined;
  const kept = events.slice(cut);
  return { events: kept, start: kept[0]?.byteOffset ?? 0 };
}

/**
 * The newest events of whole records in `[range.from, range.before)` of `file`, at most `range.limit` of
 * them unless one record holds more, and where they begin.
 *
 * Throws when the file was replaced or truncated under the read, which the caller reports as an
 * unreadable transcript rather than a short page.
 */
export async function readTranscriptPage(
  source: TranscriptSource,
  file: string,
  sessionId: string,
  range: TranscriptPageRange,
  growth: readonly number[] = LOG_PAGE_GROWTH_BYTES,
  maxScan: number = MAX_LOG_PAGE_SCAN_BYTES,
): Promise<TranscriptPage> {
  const before = Math.max(0, range.before);
  const floor = Math.min(Math.max(0, range.from), before);
  if (before === floor) return { events: [], start: floor };
  const sizes = [...growth.filter(size => size < maxScan), maxScan];
  let page: TranscriptPage = { events: [], start: floor };
  for (const size of sizes) {
    const begin = Math.max(floor, before - size);
    const read = await pageWindow(source, file, sessionId, begin, before, range.limit);
    // Nothing was dropped and the window began at the floor: the page is everything from there.
    const whole = !read.trimmed && begin === floor;
    page = {
      events: read.events,
      start: read.trimmed ? (read.events[0]?.byteOffset ?? begin) : whole ? floor : (read.firstRecord ?? begin),
    };
    if (read.trimmed || whole) break;
  }
  return page;
}

/** One window of a page: its newest whole records, whether any were dropped, and its first record. */
async function pageWindow(
  source: TranscriptSource,
  file: string,
  sessionId: string,
  begin: number,
  before: number,
  limit: number,
): Promise<{
  readonly events: readonly TranscriptEvent[];
  readonly trimmed: boolean;
  readonly firstRecord: number | undefined;
}> {
  const window = source.window(file, { sessionId, start: { at: 'offset', byteOffset: begin }, end: before });
  let events: readonly TranscriptEvent[] = [];
  let trimmed = false;
  let firstRecord: number | undefined;
  for (let step = 0; step < PAGE_STEP_LIMIT; step += 1) {
    const { batch, more } = await window.next();
    if (batch !== undefined) {
      if (batch.reset) throw new Error('the transcript was replaced while a page of it was read');
      firstRecord ??= batchStart(batch);
      const kept = newestWholeRecords(
        [...events, ...batch.events.filter(event => (event.byteOffset ?? 0) < before)],
        limit,
      );
      events = kept.events;
      trimmed ||= kept.trimmed;
    }
    if (!more) break;
  }
  return { events, trimmed, firstRecord };
}

/** Where the first record a batch read begins: its first raw record, or failing that its first event. */
const batchStart = (batch: TranscriptBatch): number | undefined =>
  batch.rawRecords?.[0]?.byteOffset ?? batch.events[0]?.byteOffset;
