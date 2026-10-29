/**
 * WHAT CROSSES BETWEEN THE EVENT LOOP AND THE TRANSCRIPT PARSE WORKER, AND IN WHAT SIZE.
 *
 * The worker (`bin/transcript-parse.worker.ts`, program `program.ts`) runs the very readers the event
 * loop would — `NodeTranscriptSource`, the `ConversationIndex`, `TranscriptImageReader`, the history and
 * import listings' file readers — so moving a read there changes where it costs, never what it answers. This module is the
 * whole of their conversation: one request per question, answered by id.
 *
 * AN ANSWER IS SENT IN PAGES. A bounded read is up to 32 MiB, and one structured-clone message holding
 * its every event and record is one synchronous deserialisation on the receiving thread — exactly the
 * single large allocation a host short of memory makes the loop wait on. So the events, raw records and
 * conversation rows of an answer travel first as {@link TranscriptParsePage}s of a bounded size, each its own message and
 * so its own turn of the loop, and the answer itself carries only what is left: a batch's cursor and
 * issues, a listing row, an image's description. A page's raw record bytes are packed into one buffer
 * that is TRANSFERRED, never copied, and read back as views of it.
 *
 * A worker posts its pages in order and then the answer, and a thread delivers its messages in the
 * order they were posted, so every page of an answer has arrived by the time the answer does.
 */

import type { ConversationPreview } from '@ferretry/protocol/conversation-import';
import type { TranscriptImageDownload } from '@ferretry/protocol/transcript-images';
import type { ConversationCandidate, DescribedConversation } from '../../../lib/imports/conversation-describer.ts';
import type { HandoffScope } from '../../../lib/imports/conversation-text.ts';
import type { ForeignHistoryCandidate, ImportedConversation } from '../../../lib/imports/foreign-history.ts';
import type { ConversationDigestFailure, PortableConversationRow } from '../../../lib/session/transcript/digest.ts';
import type { TranscriptImageFailure, TranscriptImageTarget } from '../../../lib/session/transcript/image-reader.ts';
import type { TranscriptTarget } from '../../../lib/session/transcript/reader.ts';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptHarness,
  TranscriptRawRecord,
  TranscriptReadOptions,
  TranscriptWindowOptions,
} from '../../../lib/transcript/types.ts';

/** Sent once to each new thread, before its first request: what its readers are configured with. */
export interface TranscriptParseGreeting {
  readonly op: 'configure';
  /** Where an import listing may read a hand-off pointer's document from (`FileConversationDescriber`). */
  readonly handoffScope: HandoffScope;
}

/** `fyd --check`'s probe (`probeBundledWorker`): the worker answers `{ probe: true }`. */
export interface TranscriptParseProbe {
  readonly probe: true;
}

/** Opens a window in the worker: carried by a window's first step, and by no later one. */
interface TranscriptWindowOpening {
  readonly harness: TranscriptHarness;
  readonly file: string;
  readonly options: TranscriptWindowOptions;
  /**
   * Whether the window's steps carry their raw records across. `false` steps it exactly as `true` does
   * and leaves the records in the worker: each step's shell then says `raw: false`, a batch WITHOUT
   * them. The event loop asks `false` — the one consumer that binds evidence to a window's records, the
   * conversation index, runs in the worker — so a window never moves its file's bytes between threads.
   */
  readonly raw: boolean;
}

/** One question to the worker; every one but `window-close` is answered under its `id`. */
export type TranscriptParseRequest =
  /** `TranscriptSource.read`: the whole bounded read, answered as a batch. */
  | {
      readonly id: number;
      readonly op: 'read';
      readonly harness: TranscriptHarness;
      readonly file: string;
      readonly options: TranscriptReadOptions;
    }
  /**
   * One step of window `window`. The worker holds each window it opened, by this number, and steps it;
   * a step for a window it does not hold — its thread was replaced, or it evicted the window — is
   * refused with {@link WINDOW_LOST}, unless the step carries `open`.
   */
  | {
      readonly id: number;
      readonly op: 'window-next';
      readonly window: number;
      readonly open?: TranscriptWindowOpening;
    }
  /** The event loop dropped window `window`: the worker forgets it. Never answered. */
  | { readonly op: 'window-close'; readonly window: number }
  /** `TranscriptImageReader.lookupAt` in the worker; `download` also reads the image's base64 back. */
  | {
      readonly id: number;
      readonly op: 'image';
      readonly sessionId: string;
      readonly handle: string;
      readonly target: TranscriptImageTarget;
      readonly download: boolean;
    }
  /** `ForeignTranscriptReader.read` in the worker. */
  | {
      readonly id: number;
      readonly op: 'foreign';
      readonly candidate: ForeignHistoryCandidate;
      readonly withEvents: boolean;
    }
  /** `ConversationDescriber.describe` in the worker. */
  | { readonly id: number; readonly op: 'describe'; readonly candidate: ConversationCandidate }
  /** `ConversationDescriber.preview` in the worker. */
  | { readonly id: number; readonly op: 'preview'; readonly candidate: ConversationCandidate }
  /**
   * `ConversationIndex.rows` in the worker: the session's portable rows, folded there and held there, so
   * only the rows cross — never the raw records they are chained over.
   */
  | { readonly id: number; readonly op: 'rows'; readonly target: TranscriptTarget; readonly file: string };

/** A batch with its events and raw records taken out: they travel in the pages before it. */
export type TranscriptBatchShell = Omit<TranscriptBatch, 'events' | 'rawRecords'> & {
  /** Whether the batch had raw records at all; `false` is a batch without them, not one with none. */
  readonly raw: boolean;
};

/** What a request is answered with, once its pages have arrived. */
export type TranscriptParseValue =
  | { readonly kind: 'batch'; readonly batch: TranscriptBatchShell }
  | { readonly kind: 'step'; readonly batch?: TranscriptBatchShell; readonly more: boolean }
  | {
      readonly kind: 'image';
      readonly etag: string;
      readonly image: TranscriptImageDownload['image'];
      /** Present when the request asked for the download. */
      readonly base64?: string;
    }
  /** A foreign transcript: its row and (paged) events, or why it was skipped. */
  | { readonly kind: 'foreign'; readonly conversation: ImportedConversation }
  | { readonly kind: 'foreign-skipped'; readonly reason: string }
  | { readonly kind: 'described'; readonly described: DescribedConversation | undefined }
  | { readonly kind: 'preview'; readonly preview: ConversationPreview | undefined }
  /**
   * A conversation's rows, which travel in the pages before it. `unspoken` is the index's `undefined`:
   * no source speaks the session's harness — not a conversation with no rows.
   */
  | { readonly kind: 'rows'; readonly unspoken?: true };

/** A page's raw records: one transferred buffer, and where each record lies in it. */
interface TranscriptRawPage {
  readonly buffer: ArrayBuffer;
  readonly records: readonly { readonly byteOffset: number; readonly start: number; readonly length: number }[];
}

/** Part of an answer: some of its events, in order, and the raw records that go with them — or some of its rows. */
export interface TranscriptParsePage {
  readonly events: readonly TranscriptEvent[];
  readonly raw?: TranscriptRawPage;
  /**
   * Some of a conversation's rows, in order. Plain data: each row's `rawPrefix` is a 32-byte array,
   * cloned with it (a fresh 32-byte buffer each side, never a view of a larger one).
   */
  readonly rows?: readonly PortableConversationRow[];
}

/**
 * A refusal: the error's own message, and an image or digest refusal's failure so it is raised as one
 * again — a route tells a damaged transcript from a broken daemon by the error's class.
 */
export interface TranscriptParseRefusal {
  readonly message: string;
  readonly imageFailure?: TranscriptImageFailure;
  readonly digestFailure?: ConversationDigestFailure;
}

/** One message from the worker. */
export type TranscriptParseResponse =
  | { readonly id: number; readonly page: TranscriptParsePage }
  | { readonly id: number; readonly ok: true; readonly value: TranscriptParseValue }
  | { readonly id: number; readonly ok: false; readonly refusal: TranscriptParseRefusal }
  | { readonly probe: true };

/** Why a window's step was refused because the worker no longer holds it. */
export const WINDOW_LOST = 'the transcript worker no longer holds this window';

/** The most events one page carries. */
const PAGE_EVENTS = 256;
/** The most raw record bytes one page carries, unless a single record is larger on its own. */
const PAGE_RAW_BYTES = 1024 * 1024;
/**
 * The most conversation rows one page carries. A row is its text and a few fixed fields, so a page is
 * about 256 messages' worth of text — the same order as a page of events.
 */
const PAGE_ROWS = 256;

/** One page and the buffers its message transfers. */
export interface OutgoingPage {
  readonly page: TranscriptParsePage;
  readonly transfer: readonly ArrayBuffer[];
}

/**
 * `events` and `rawRecords` cut into pages of at most {@link PAGE_EVENTS} events and about
 * {@link PAGE_RAW_BYTES} raw bytes, in order. Each page's records are COPIED into one fresh buffer, so
 * what is transferred is exactly their bytes — a record is a view of its read, and posting the view
 * would clone the whole read behind it. No page at all for an answer with neither.
 */
export function pagesOf(
  events: readonly TranscriptEvent[],
  rawRecords: readonly TranscriptRawRecord[] = [],
): readonly OutgoingPage[] {
  const pages: OutgoingPage[] = [];
  let event = 0;
  let record = 0;
  while (event < events.length || record < rawRecords.length) {
    const pageEvents = events.slice(event, event + PAGE_EVENTS);
    event += pageEvents.length;
    let bytes = 0;
    const first = record;
    while (record < rawRecords.length) {
      const length = rawRecords[record]?.bytes.byteLength ?? 0;
      if (record > first && bytes + length > PAGE_RAW_BYTES) break;
      bytes += length;
      record += 1;
    }
    if (record === first) {
      pages.push({ page: { events: pageEvents }, transfer: [] });
      continue;
    }
    const buffer = new ArrayBuffer(bytes);
    const view = new Uint8Array(buffer);
    const placed: { byteOffset: number; start: number; length: number }[] = [];
    let start = 0;
    for (const each of rawRecords.slice(first, record)) {
      view.set(each.bytes, start);
      placed.push({ byteOffset: each.byteOffset, start, length: each.bytes.byteLength });
      start += each.bytes.byteLength;
    }
    pages.push({ page: { events: pageEvents, raw: { buffer, records: placed } }, transfer: [buffer] });
  }
  return pages;
}

/** `rows` cut into pages of at most {@link PAGE_ROWS} rows, in order; no page at all for none. */
export function rowPagesOf(rows: readonly PortableConversationRow[]): readonly OutgoingPage[] {
  const pages: OutgoingPage[] = [];
  for (let start = 0; start < rows.length; start += PAGE_ROWS)
    pages.push({ page: { events: [], rows: rows.slice(start, start + PAGE_ROWS) }, transfer: [] });
  return pages;
}

/** The events, raw records and rows of an answer, put back together from its pages, in order. */
export function joinPages(pages: readonly TranscriptParsePage[]): JoinedPages {
  const joined = startJoin();
  for (const page of pages) joinPage(joined, page);
  return joined;
}

/** What an answer's pages hold, put back together; grown one page at a time by {@link joinPage}. */
export interface JoinedPages {
  readonly events: TranscriptEvent[];
  readonly rawRecords: TranscriptRawRecord[];
  readonly rows: PortableConversationRow[];
}

/** Nothing joined yet. */
export function startJoin(): JoinedPages {
  return { events: [], rawRecords: [], rows: [] };
}

/**
 * Appends one page to `joined`, as the page arrives. Joined after the answer instead, a 32 MiB read was
 * one synchronous pass over every event and record on the receiving thread — the pass paging exists to
 * avoid; joined here, it is one page's worth per message, each its own turn of the loop.
 */
export function joinPage(joined: JoinedPages, page: TranscriptParsePage): void {
  for (const each of page.events) joined.events.push(each);
  for (const each of page.rows ?? []) joined.rows.push(each);
  if (page.raw === undefined) return;
  for (const each of page.raw.records)
    joined.rawRecords.push({
      byteOffset: each.byteOffset,
      bytes: new Uint8Array(page.raw.buffer, each.start, each.length),
    });
}
