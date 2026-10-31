/**
 * SEARCH WITHIN A CONVERSATION — the whole transcript, not just what the chat has loaded.
 *
 * A search reads the transcript's records newest first (`TranscriptRecordScanner`), parses each one
 * through the session's own source, and keeps the events `accept` takes, until it holds `limit` of
 * them or the file is read. Newest first because that is where a reader looks first and where most
 * answers are; a search that found enough stops there, and says the rest was not read (`truncated`).
 *
 * The scanner may skip records by their raw bytes, given a needle that cannot be spelled differently in
 * JSON (`prefilterNeedle`). It never decides a match: every event that reaches the caller was parsed
 * and judged by `accept` on its own text.
 */

import type { TranscriptEvent, TranscriptSource } from '../../transcript/types.ts';

/** One record of a transcript file: its first byte and the byte after its newline. */
export interface TranscriptRecordRange {
  readonly start: number;
  readonly end: number;
}

/** The records of a transcript file, newest first, optionally only those whose raw bytes hold `needle`. */
export interface TranscriptRecordScanner {
  records(file: string, needle: string | undefined): AsyncIterable<TranscriptRecordRange>;
}

/** What a search found: the accepted events in file order, and whether older records went unread. */
export interface TranscriptSearchResult {
  readonly events: readonly TranscriptEvent[];
  readonly truncated: boolean;
}

/**
 * The most records one search parses. A query whose needle is in nearly every record — or one with no
 * needle at all — would otherwise parse the whole conversation; it answers what it found by then.
 */
export const MAX_SEARCH_RECORDS = 20_000;

/**
 * The longest run of the lower-cased query a raw JSONL record must contain to hold the query at all,
 * or nothing when no run is safe.
 *
 * A JSON writer leaves printable ASCII as it is, except the quote and the backslash it escapes; and a
 * case-insensitive match of an ASCII letter is the same byte, folded. So a run of those characters
 * appears verbatim in the record's bytes whenever the decoded text holds the query. Anything else — a
 * non-ASCII letter whose case folds outside ASCII, a quote, a control character — ends a run.
 */
export function prefilterNeedle(query: string): string | undefined {
  let best = '';
  for (const run of query.toLowerCase().split(/[^\x20-\x21\x23-\x5b\x5d-\x7e]+/u))
    if (run.length > best.length) best = run;
  return best === '' ? undefined : best;
}

/**
 * Up to `limit` events `accept` takes, newest first in the reading and returned in file order.
 *
 * Throws when the file is replaced under the read, which the caller reports as an unreadable transcript.
 */
export async function searchTranscriptRecords(
  source: TranscriptSource,
  scanner: TranscriptRecordScanner,
  file: string,
  sessionId: string,
  query: { readonly needle: string | undefined; readonly accept: (event: TranscriptEvent) => boolean },
  limit: number,
  maxRecords: number = MAX_SEARCH_RECORDS,
): Promise<TranscriptSearchResult> {
  const found: TranscriptEvent[][] = [];
  let count = 0;
  let parsed = 0;
  for await (const record of scanner.records(file, query.needle)) {
    if (count >= limit || parsed >= maxRecords) return { events: found.reverse().flat(), truncated: true };
    parsed += 1;
    const accepted = (await recordEvents(source, file, sessionId, record)).filter(query.accept);
    if (accepted.length === 0) continue;
    found.push(accepted);
    count += accepted.length;
  }
  return { events: found.reverse().flat(), truncated: false };
}

/** The events of one record, read through a window that holds exactly it. */
async function recordEvents(
  source: TranscriptSource,
  file: string,
  sessionId: string,
  record: TranscriptRecordRange,
): Promise<readonly TranscriptEvent[]> {
  const window = source.window(file, { sessionId, start: { at: 'offset', byteOffset: record.start }, end: record.end });
  const events: TranscriptEvent[] = [];
  for (let step = 0; step < 16; step += 1) {
    const { batch, more } = await window.next();
    if (batch?.reset === true) throw new Error('the transcript was replaced while it was searched');
    if (batch !== undefined) events.push(...batch.events);
    if (!more) break;
  }
  return events;
}
