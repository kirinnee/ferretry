/**
 * The operator TRANSCRIPT reads for one ferret: the tail of its own harness transcript as text, a page of it with
 * where it sits, a search inside it, and the conversation as ADDRESSABLE ROWS. (The event history and the live screen are
 * Ferrets' and Terminals' reads, not this service's.)
 *
 * DAMAGED STATE IS NOT EMPTY STATE, and that rule is the reason every method here can refuse:
 *
 * - A ferret the daemon cannot prove a transcript file for has no transcript. The send path deliberately projects that
 *   as an empty read, which is right for a question watcher that must not fail an operation over missing evidence and
 *   wrong for an operator asking to SEE the transcript: they would be shown a blank page and conclude the agent said
 *   nothing. So the port that feeds this module reports resolution separately, and an unresolved ferret is refused.
 * - A page of ADDRESSABLE ROWS is the same evidence as the tail and a stronger promise about it. A reader offering
 *   "fork from here" needs the coordinate the daemon minted for that exact durable message; a coordinate taken from a
 *   rendered line, a row index or a text hash addresses whichever message now happens to sit there. So this page is
 *   served only from a COMPLETED provenance the daemon has already persisted, it pages strictly after a cursor it
 *   authenticated itself, and every row carries opaque evidence that its raw content is still the raw content this
 *   read saw (G41: bounded fragments).
 *
 * EVERYTHING THAT LEAVES HERE IS SCRUBBED. Every read passes through a redactor before it is answered, because this is the
 * surface a person actually reads a ferret on, and "a secret never appears in your transcripts" is a promise about
 * exactly this code path. The redactor is a port rather than the vault itself (the kernel's read-scoped `Redaction`).
 */

import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { Instant, JsonValue } from '@ferretry/std';
import {
  formatTranscriptImageMarker,
  type LogPage,
  type LogSearch,
  type TranscriptEvent as TranscriptEventView,
  type TranscriptEventTail,
  type TranscriptMessage,
  type TranscriptPage,
} from '../../../contract/index.ts';
import {
  type ConversationMessagePoint,
  type ExactConversationMessagePoint,
  ExactConversationMessagePointSchema,
  formatPoint,
} from './session/protocol.ts';
import { markerMediaType, numberRecordImages, type RecordImage } from './transcript/images.ts';
import { isOwnerMessage } from './transcript/owner.ts';
import { snippetAround } from './transcript/search.ts';
import type { TranscriptEvent } from './transcript/types.ts';
import { type PortableConversationRow, sameConversationMessagePoint } from './session/digest.ts';
import { prefilterNeedle } from './session/log-search.ts';
import {
  issueSessionTranscriptMessageToken,
  readSessionTranscriptMessageCursor,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
  type SessionTranscriptMessageTokenCodec,
  type SessionTranscriptMessageTokenContext,
  verifySessionTranscriptMessageToken,
} from './session/message-token.ts';

/**
 * One opened set of values, as `batch` hands it over: pure, and valid only while that batch runs.
 * Structurally `lib/secrets`'s `Scrub`, declared here for the reason the redactor is.
 */
interface TranscriptReadScrub {
  text(text: string): string;
  data(value: unknown): unknown;
}

/**
 * Scrubbing, as this surface needs it.
 *
 * The part of `lib/secrets`'s `TextRedactor` this surface uses, deliberately declared here: the read
 * surface must not depend on the secret subsystem to serve a transcript, and a daemon that has no
 * secret store still has all three reads.
 *
 * A page of many strings goes through `batch`, never `redact` per string: each call is a vault open,
 * which is a read of the key file and the ciphertext from disk.
 */
export interface TranscriptReadRedactor {
  redact(text: string): Promise<string>;
  batch<T>(work: (scrub: TranscriptReadScrub) => T): Promise<T>;
}

/** A daemon with nothing to scrub. Its input is its output — a fact, not a fallback. */
const UNREDACTED: TranscriptReadRedactor = {
  redact: async text => text,
  batch: async work => work({ text: text => text, data: value => value }),
};

/** Why a read could not be answered. */
export type TranscriptReadFailure =
  /** The caller's own query is not one the read can be performed for. */
  | 'invalid_query'
  /** The daemon cannot prove which transcript file is this session's. */
  | 'no_transcript'
  /** A transcript was proved, but it could not be read as evidence. */
  | 'transcript_unreadable'
  /** The transcript is readable but does not prove the requested turn boundary. */
  | 'turn_partition_unavailable'
  /** A page of durable evidence contradicted the requested session or cursor. */
  | 'event_evidence_mismatch'
  /**
   * A well-formed message cursor no longer names the raw conversation prefix it was issued over.
   *
   * ONE answer for every well-formed disagreement — a tampered tag, another session's context, a
   * re-resolved provenance, an anchor that was rewritten or truncated away. Distinguishing them
   * would tell a caller WHICH part of the evidence they got wrong, which is the map an attacker is
   * missing. Malformed cursor syntax is a different answer, `invalid_query`, because that one is the
   * caller's own mistake rather than a statement about this session's transcript.
   */
  | 'message_cursor_stale'
  /**
   * A page of older history was asked for against a transcript file other than the one the caller's
   * earlier pages came from — the session was re-bound, or its file replaced. Byte offsets name places
   * in ONE file, so the caller starts again from the tail rather than stitching two files together.
   */
  | 'log_cursor_stale';

type LogSearchMatch = LogSearch['matches'][number];

export class TranscriptReadError extends Error {
  constructor(
    readonly failure: TranscriptReadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptReadError';
  }
}

/** A transcript read that reports whether the file was RESOLVED, separately from what it contained. */
export type TranscriptTailResult =
  /** The daemon cannot prove which transcript file belongs to this session. */
  | { readonly kind: 'unresolved' }
  /** The exact file was proved, but it disappeared or could not be parsed when it was read. */
  | { readonly kind: 'unreadable' }
  /** A file was resolved and read. `events` may legitimately be empty — the agent has not spoken yet. */
  | { readonly kind: 'read'; readonly events: readonly TranscriptEvent[] };

export interface SessionTranscriptTail {
  tail(sessionId: string, limit: number): Promise<TranscriptTailResult>;
}

/** Which page of a transcript a `logPage` read is for: the tail when `before` is absent. */
interface TranscriptPageQuery {
  /** The byte the page ends before — the `start` of the page the caller already holds. */
  readonly before?: number;
  /** The lowest byte the page may begin at; only meaningful with `before`. */
  readonly from?: number;
  readonly limit: number;
}

/**
 * A page read that reports resolution separately from content, as {@link TranscriptTailResult} does.
 *
 * `file` names the transcript file the page was read from — an opaque token, never its path — so a
 * caller can tell that a later page would come from a different file. `start` is the record boundary
 * the page begins at (see `readTranscriptPage`).
 */
export type TranscriptPageResult =
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'read';
      readonly events: readonly TranscriptEvent[];
      readonly start: number;
      readonly file: string;
    };

/** Pages of one session's transcript, newest first, each ending where the last began. */
export interface SessionTranscriptPages {
  page(sessionId: string, query: TranscriptPageQuery): Promise<TranscriptPageResult>;
}

/** What a transcript search asks the file for: a needle the raw records must hold, and the test for an event. */
interface TranscriptSearchQuery {
  readonly needle: string | undefined;
  readonly accept: (event: TranscriptEvent) => boolean;
  readonly limit: number;
}

/** A search read that reports resolution separately from content, as {@link TranscriptPageResult} does. */
export type TranscriptSearchReadResult =
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'read';
      readonly events: readonly TranscriptEvent[];
      readonly truncated: boolean;
      readonly file: string;
    };

/** The whole of one session's transcript, searched (`searchTranscriptRecords`). */
export interface SessionTranscriptSearch {
  search(sessionId: string, query: TranscriptSearchQuery): Promise<TranscriptSearchReadResult>;
}

/** The stand-in for a daemon that wired no search: an honest refusal, never "no matches". */
const NO_SEARCH: SessionTranscriptSearch = {
  // read-scoped: none — the port returns raw events to the service, which masks every snippet through the read-scoped redactor
  search: async () => ({ kind: 'unreadable' }),
};

/** The stand-in for a daemon that wired no pages: an honest refusal, never an empty page. */
const NO_PAGES: SessionTranscriptPages = {
  page: async () => ({ kind: 'unreadable' }),
};

/**
 * ONE completed read of one session's addressable conversation.
 *
 * THE ROW TYPE IS THE DIGEST OWNER'S, imported rather than restated. {@link PortableConversationRow}
 * is the one carrier for "a portable message and the commitment to the raw prefix ending at it", and
 * this surface is a CONSUMER of it. A second declaration here would have been a parallel spelling of
 * one fact: the two would agree until one changed, and the half that drifted would describe a row the
 * fork cannot actually be cut at. Nothing is lost by consuming it — {@link servedRow} builds the
 * protocol's own `SessionTranscriptMessage` from these fields, so a row shape that stopped satisfying
 * the wire row still fails to compile, which is where that check belongs.
 *
 * Its `rawPrefix` is EVIDENCE AND NEVER CONTENT: the rolling commitment computed over every physical
 * record up to and including this row's, and private. Published bare beside a redacted display it
 * would be an offline oracle against the very text redaction removed. It leaves this module only
 * inside a MAC, and it never reaches the wire.
 *
 * The `read` variant carries the token context its rows were produced under — which session, which
 * run of it, and the COMPLETED provenance the daemon has already persisted — because a coordinate
 * means nothing without them: the same byte offset in a relaunched session, or in a transcript file
 * later re-resolved to somebody else's rollout, is a different message.
 *
 * The two refusing shapes are the transcript tail's own vocabulary, deliberately. An operator who
 * asked for addressable rows and is handed an empty page concludes there is nothing here to fork
 * from, which is the same false blank the tail refuses rather than serves.
 */
export type MessageRowReadResult =
  /** The daemon cannot prove which transcript file belongs to this session. */
  | { readonly kind: 'unresolved' }
  /**
   * The exact file was proved, but it could not be read COMPLETELY as evidence.
   *
   * It covers a file that vanished, would not parse, or held a record past the per-record bound. A
   * transcript's SIZE is no longer one of them: the conversation index folds a long transcript a bounded
   * read at a time, and leaves a live writer's unterminated last line for the next read. It stays one
   * variant because a shorter-looking conversation is LOST HISTORY, not a valid prefix, and serving its
   * rows would offer a fork cut at a coordinate whose prefix the daemon never actually saw.
   *
   * `reason` is the refusal's own words, for the human reading the error: which of those it was.
   */
  | { readonly kind: 'unreadable'; readonly reason?: string }
  /** A completed read. `rows` may legitimately be empty — nothing portable has been said yet. */
  | {
      readonly kind: 'read';
      readonly context: SessionTranscriptMessageTokenContext;
      readonly rows: readonly PortableConversationRow[];
    };

/**
 * The addressable conversation of one session, from ONE read.
 *
 * WHY THIS IS A PORT RATHER THAN WORK DONE HERE. Deciding which file is a session's transcript,
 * reading its bytes and folding them into the rolling commitment are each owned elsewhere — by the
 * provenance owner, by the one transcript parser, and by the one digest owner. What this module owns
 * is paging, authenticating and scrubbing what that single read produced. A second reader here would
 * be a second answer to "what does this transcript say", free to disagree with the answer a fork is
 * actually cut from, and the whole value of a durable coordinate is that those two never differ.
 *
 * One call answers one page: the anchor is resolved, the rows are served and every token is issued
 * from the same read, so no page is ever assembled from two views of a file that changed in between.
 */
export interface MessageRowSource {
  read(sessionId: string): Promise<MessageRowReadResult>;
}

/** Addressable rows a `messages` page serves when the caller names no limit. */
export const DEFAULT_MESSAGE_PAGE = 200;

/** Largest addressable-row page one `messages` read will serve, matching the client's own ceiling. */
export const MAX_MESSAGE_PAGE = 1_000;

/**
 * Which end a `messages` read counts from when it reads BACKWARD: the newest rows (`through` absent), or the
 * newest rows ending at the row a cursor names, inclusive. A forward cursor and a backward one are the same token.
 */
export interface MessageBackwardRead {
  readonly through?: string;
}

/** Transcript events a `logs` read returns when the caller names no limit. */
export const DEFAULT_LOG_TAIL = 200;

/** Largest transcript tail a single `logs` read will render. */
export const MAX_LOG_TAIL = 2_000;

/** Matches a `logSearch` answers when the caller names no limit, and the most it will. */
const DEFAULT_LOG_SEARCH = 500;
const MAX_LOG_SEARCH = 2_000;

/** The longest query a search takes. */
const MAX_LOG_SEARCH_QUERY = 200;

/** Two digits, for a wall-clock stamp. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The wall-clock time of a transcript event, or nothing.
 *
 * A record whose stamp is missing or unparseable renders WITHOUT a time rather than with a made-up
 * one: `00:00:00` beside a real message is a claim about when the agent said it.
 */
function stamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return undefined;
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
}

/** Whether a window beginning at `start` would begin inside a record: the event before it shares its bytes. */
function cutsRecord(events: readonly TranscriptEvent[], start: number): boolean {
  const before = events[start - 1];
  const first = events[start];
  if (first === undefined) return false;
  if (before === undefined) return false;
  return (
    before.byteOffset !== undefined && before.byteOffset === first.byteOffset && before.byteLength === first.byteLength
  );
}

/** A number as letters a-j, so the stand-in for a marker holds no digit a masking redactor could eat. */
const spell = (index: number): string =>
  String(index).replace(/\d/gu, digit => String.fromCharCode(97 + Number(digit)));
const unspell = (letters: string): number =>
  Number(letters.replace(/[a-j]/gu, letter => String(letter.charCodeAt(0) - 97)));

/** The NUL that fences a lifted marker: no secret a redactor masks can contain it. */
const NUL = String.fromCharCode(0);
const LIFTED_MARKER = new RegExp(`${NUL}fy-image-([a-j]+)${NUL}`, 'gu');

/** How a rendered log spells the marker for one image. */
type MarkImage = (image: RecordImage) => string;

const imageMarker: MarkImage = image =>
  formatTranscriptImageMarker({ handle: image.handle, mediaType: markerMediaType(image) });

/**
 * The body of one transcript event, as a human reads it.
 *
 * `images` are the ones this event holds that a chat can ask for (`numberRecordImages`). An image
 * attachment keeps its kind word and gains the marker after it; a tool result keeps its text and gains
 * one marker line per image, in place of the JSON dump that an image-only result used to print — which
 * was the image's base64 whenever it was small enough to be parsed.
 */
function body(event: TranscriptEvent, images: readonly RecordImage[] = [], mark: MarkImage = imageMarker): string {
  switch (event.kind) {
    case 'message':
    case 'reasoning':
      return event.text;
    case 'tool-call':
      return `${event.call.name}(${JSON.stringify(event.call.input)})`;
    case 'tool-result': {
      const prefix = event.result.isError ? 'error ' : '';
      if (images.length === 0) return `${prefix}${event.result.text ?? JSON.stringify(event.result.content)}`;
      return [`${prefix}${event.result.text ?? ''}`.trimEnd(), ...images.map(mark)]
        .filter(line => line !== '')
        .join('\n');
    }
    case 'attachment': {
      const marker = images[0];
      if (marker !== undefined) return `${event.attachment.kind} ${mark(marker)}`;
      return `${event.attachment.kind}${event.attachment.kind === 'remote-control' ? ` ${event.attachment.url}` : ''}`;
    }
    case 'error':
      return `${event.error.code === undefined ? '' : `${event.error.code}: `}${event.error.message}`;
    case 'usage':
      return `in=${event.usage.inputTokens ?? 0} out=${event.usage.outputTokens ?? 0}`;
    case 'turn':
      return event.state;
    case 'compaction':
      return `compacted${event.trigger === undefined ? '' : ` (${event.trigger})`}`;
    default:
      return JSON.stringify(event.settings);
  }
}

/**
 * A transcript tail as plain text, one event per line.
 *
 * Multi-line bodies are indented under their own header rather than flattened, so a code block an
 * agent wrote is still readable and a reader can still tell where one event ends and the next begins.
 *
 * An image a chat can ask for carries a `[fy-image <handle> <type>]` marker (see
 * `@ferretry/protocol`'s `transcript-images.ts`). `partialFirstRecord` says the first record may have
 * lost its leading events to a window cut, so its images cannot be numbered and stay unmarked.
 */
export function renderTranscript(
  events: readonly TranscriptEvent[],
  options: { readonly partialFirstRecord?: boolean; readonly mark?: MarkImage } = {},
): string {
  const images = numberRecordImages(events, options);
  return events
    .map((event, index) => {
      const when = stamp(event.timestamp);
      const header = `${when === undefined ? '' : `[${when}] `}${event.role}/${event.kind}`;
      const [first = '', ...rest] = body(event, images[index], options.mark).split('\n');
      return [`${header}: ${first}`, ...rest.map(line => `    ${line}`)].join('\n');
    })
    .join('\n');
}

/** A bound the caller supplied, validated against this read's own ceiling. */
function boundedLimit(value: number | undefined, fallback: number, ceiling: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
    throw new TranscriptReadError('invalid_query', `${name} must be an integer between 1 and ${ceiling}`);
  return value;
}

/**
 * The public point inside a continuation token, or a refusal of the caller's own string.
 *
 * A blank value is refused rather than treated as "no cursor". `?cursor=` means the caller believed it
 * held a continuation token, and answering the FIRST page for it would silently restart a walk they
 * thought they were resuming — which reads as a conversation that repeats itself. Reading the point is
 * deliberately separate from trusting it: the token owner recovers the coordinate, and only the tag
 * verified against a freshly read row decides whether it names anything.
 */
function cursorAnchor(cursor: string): ConversationMessagePoint {
  const anchor = cursor.trim() === '' ? undefined : readSessionTranscriptMessageCursor(cursor);
  if (anchor === undefined)
    throw new TranscriptReadError('invalid_query', 'cursor is not a well-formed continuation token');
  return anchor;
}

/** The one public answer for every well-formed cursor this read cannot honour. */
function staleCursor(sessionId: string): TranscriptReadError {
  return new TranscriptReadError(
    'message_cursor_stale',
    `session ${sessionId}'s conversation no longer reads as it did where that page ended`,
  );
}

/**
 * Every operator read over one session, in one service because they share exactly one rule: an
 * answer this daemon cannot stand behind is a refusal, never a blank.
 */
export class TranscriptReadService {
  constructor(
    private readonly transcript: SessionTranscriptTail,
    /**
     * REQUIRED, and required HERE rather than after the two defaults below.
     *
     * There is no honest default for it. A stand-in that answered "no rows" would serve an empty page
     * for every session on a daemon whose composition root forgot to wire the read — the exact
     * silent-blank failure the rest of this module refuses — and a default cannot precede a required
     * parameter in any case. Its position is therefore load-bearing: a caller that passed the stored
     * snapshot reader positionally must be updated, which is the point.
     */
    private readonly messageSource: MessageRowSource,
    /**
     * The daemon-private MAC, as two operations and no key bytes.
     *
     * Separate from the source on purpose: one port answers what the transcript says, the other
     * proves this daemon said it. Merging them would put key custody inside a transcript reader, and
     * this class must be unable to read a key however it is wired.
     */
    private readonly messageTokens: SessionTranscriptMessageTokenCodec,
    private readonly redactor: TranscriptReadRedactor = UNREDACTED,
    private readonly pages: SessionTranscriptPages = NO_PAGES,
    private readonly search: SessionTranscriptSearch = NO_SEARCH,
  ) {}

  /**
   * The tail of the session's own harness transcript, as text.
   *
   * An UNRESOLVED transcript refuses. `SessionTranscriptReader` projects it as an empty read on
   * purpose — a watcher must not fail an operation over missing evidence — but an operator who asked
   * to read the transcript and is handed a blank page concludes the agent said nothing, which is a
   * claim the daemon has no basis for. An empty read of a file it DID resolve is served as empty,
   * because that one is a fact.
   */
  async logs(sessionId: string, limit: number | undefined, turn?: number): Promise<string> {
    const tail = boundedLimit(limit, DEFAULT_LOG_TAIL, MAX_LOG_TAIL, 'limit');
    const result = await this.transcript.tail(sessionId, tail);
    if (result.kind === 'unresolved')
      throw new TranscriptReadError(
        'no_transcript',
        `session ${sessionId} has no transcript this daemon can prove is its own`,
      );
    if (result.kind === 'unreadable')
      throw new TranscriptReadError(
        'transcript_unreadable',
        `session ${sessionId} has a proved transcript, but this daemon could not read it`,
      );
    // A tail of exactly `tail` events may have been cut inside its first record, and a record's images are
    // numbered from its first event — so that first record stays unmarked rather than named wrongly.
    if (turn === undefined)
      return await this.renderRedacted(result.events, { partialFirstRecord: result.events.length >= tail });
    if (!Number.isSafeInteger(turn) || turn < 0)
      throw new TranscriptReadError('invalid_query', 'turn must be a non-negative integer');
    const starts = result.events.flatMap((event, index) =>
      event.kind === 'turn' && event.state === 'started' ? [index] : [],
    );
    const start = starts[turn];
    if (start === undefined)
      throw new TranscriptReadError(
        'turn_partition_unavailable',
        `session ${sessionId}'s transcript has no discernible boundary for turn ${turn}`,
      );
    const end = starts[turn + 1] ?? result.events.length;
    const turnEvents = result.events.slice(start, end);
    return await this.renderRedacted(turnEvents.slice(-tail), {
      partialFirstRecord:
        turnEvents.length > tail || (start === 0 ? result.events.length >= tail : cutsRecord(result.events, start)),
    });
  }

  /**
   * The newest events of the session's transcript as DATA: its messages, the tool calls it made and their results,
   * oldest first, for a check that reads what a turn did (a PR it opened, a command it ran). Reasoning, attachments,
   * turn markers and the rest are not carried.
   *
   * EVERYTHING IS SCRUBBED, and a tool call is where a secret most likely sits (a command line, a request body, a file
   * a tool printed), so a call's input and a result's content go through the same redaction read as the text does: one
   * vault open for the whole tail, every string in it masked, the structure untouched. An UNRESOLVED transcript refuses,
   * as `logs` does: an empty tail of a file nobody proved is the ferret's would read as "it did nothing".
   */
  async transcriptEvents(sessionId: string, limit: number | undefined): Promise<TranscriptEventTail> {
    const tail = boundedLimit(limit, DEFAULT_LOG_TAIL, MAX_LOG_TAIL, 'limit');
    const result = await this.transcript.tail(sessionId, tail);
    if (result.kind === 'unresolved')
      throw new TranscriptReadError(
        'no_transcript',
        `session ${sessionId} has no transcript this daemon can prove is its own`,
      );
    if (result.kind === 'unreadable')
      throw new TranscriptReadError(
        'transcript_unreadable',
        `session ${sessionId} has a proved transcript, but this daemon could not read it`,
      );
    const events = await this.redactor.batch(scrub =>
      result.events.flatMap((event): TranscriptEventView[] => eventView(event, scrub)),
    );
    return { v: 1, ferret: sessionId as FerretId, events };
  }

  /**
   * One page of the session's transcript as the chat renders it: the tail, or the page before a byte.
   *
   * The same text as `logs` — one event per line, scrubbed, image markers intact — plus where the page
   * begins and which file it came from, so the reader can ask for the page before this one and lay the
   * two end to end. A page never begins inside a record, so its images are numbered from the first.
   *
   * `file`, when given, is the token an earlier page carried. A page of a different file is refused
   * (`log_cursor_stale`): its offsets name places in a conversation the caller has never seen.
   */
  async logPage(
    sessionId: string,
    query: { readonly before?: number; readonly from?: number; readonly limit?: number; readonly file?: string },
  ): Promise<LogPage> {
    const limit = boundedLimit(query.limit, DEFAULT_LOG_TAIL, MAX_LOG_TAIL, 'limit');
    const offset = (value: number | undefined, name: string): number | undefined => {
      if (value === undefined) return undefined;
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TranscriptReadError('invalid_query', `${name} must be a non-negative integer`);
      return value;
    };
    const before = offset(query.before, 'before');
    const from = offset(query.from, 'from');
    if (from !== undefined && before === undefined)
      throw new TranscriptReadError('invalid_query', 'from is only meaningful with before');
    if (from !== undefined && before !== undefined && from > before)
      throw new TranscriptReadError('invalid_query', 'from must not be past before');
    const result = await this.pages.page(sessionId, {
      limit,
      ...(before === undefined ? {} : { before }),
      ...(from === undefined ? {} : { from }),
    });
    if (result.kind === 'unresolved')
      throw new TranscriptReadError(
        'no_transcript',
        `session ${sessionId} has no transcript this daemon can prove is its own`,
      );
    if (result.kind === 'unreadable')
      throw new TranscriptReadError(
        'transcript_unreadable',
        `session ${sessionId} has a proved transcript, but this daemon could not read it`,
      );
    if (query.file !== undefined && query.file !== result.file)
      throw new TranscriptReadError(
        'log_cursor_stale',
        `session ${sessionId}'s transcript is no longer the file those pages came from`,
      );
    const log = await this.renderRedacted(result.events, { partialFirstRecord: false });
    // One per rendered event, in order: where in the file each line of `log` came from, so a search hit
    // (`logSearch`) can be found among the rows the chat drew from these pages.
    const offsets = result.events.map(event => event.byteOffset ?? result.start);
    return { v: 1, ferret: sessionId as FerretId, log, start: result.start, file: result.file, offsets };
  }

  /**
   * Every place in the session's whole transcript that says `q`, newest first in the reading and
   * answered oldest first — the chat's search, over what it has not loaded as much as what it has.
   *
   * WHAT IS SEARCHED is what the chat shows: a message's text, and with `tools` a reasoning block, a
   * tool call (its name and input) and a tool's result. `who` narrows it to the owner's own messages
   * (`me`, never text the harness wrote into the user channel) or to the agent's (`agent`).
   *
   * SECRETS STAY MASKED. An event is a match only if its SCRUBBED text holds the query, and its snippet
   * is cut from that scrubbed text — so the search cannot be used to ask whether a secret value appears,
   * and no snippet carries one. The raw text only chooses which records are worth scrubbing.
   *
   * `truncated` says older records were not read because `limit` matches were found first; both count scrubbed
   * matches only.
   */
  async logSearch(
    sessionId: string,
    query: { readonly q: string; readonly who?: string; readonly tools?: boolean; readonly limit?: number },
  ): Promise<LogSearch> {
    const limit = boundedLimit(query.limit, DEFAULT_LOG_SEARCH, MAX_LOG_SEARCH, 'limit');
    const text = query.q.trim();
    if (text === '' || text.length > MAX_LOG_SEARCH_QUERY)
      throw new TranscriptReadError('invalid_query', `q must be 1 to ${MAX_LOG_SEARCH_QUERY} characters`);
    const who = query.who ?? 'all';
    if (who !== 'all' && who !== 'me' && who !== 'agent')
      throw new TranscriptReadError('invalid_query', 'who must be all, me or agent');
    const needle = text.toLowerCase();
    const shown = (event: TranscriptEvent): boolean =>
      (who === 'me'
        ? isOwnerMessage(event)
        : who === 'agent'
          ? event.role === 'assistant'
          : event.role === 'user' || event.role === 'assistant' || event.role === 'tool') &&
      (event.kind === 'message' ||
        (query.tools === true &&
          (event.kind === 'reasoning' || event.kind === 'tool-call' || event.kind === 'tool-result')));
    // One redaction read for the whole search: an event is accepted, and counted against `limit` and `truncated`, only
    // when its SCRUBBED text holds the query, so neither the matches nor `truncated` can say a secret appears. The raw
    // needle only chooses which records are worth scrubbing.
    const { result, matches } = await this.redactor.batch(async scrub => {
      const scrubbed = new Map<TranscriptEvent, string>();
      const scrubbedBody = (event: TranscriptEvent): string => {
        let held = scrubbed.get(event);
        if (held === undefined) {
          held = scrub.text(body(event));
          scrubbed.set(event, held);
        }
        return held;
      };
      const found = await this.search.search(sessionId, {
        needle: prefilterNeedle(text),
        accept: event => shown(event) && scrubbedBody(event).toLowerCase().includes(needle),
        limit,
      });
      if (found.kind !== 'read') return { result: found, matches: [] };
      return {
        result: found,
        matches: found.events.flatMap((event): LogSearchMatch[] => {
          const shownText = scrubbedBody(event);
          const at = shownText.toLowerCase().indexOf(needle);
          if (at < 0) return [];
          return [
            {
              offset: event.byteOffset ?? 0,
              role: event.role,
              kind: event.kind,
              snippet: snippetAround(shownText, at, needle.length),
              ...(event.timestamp === undefined ? {} : { at: event.timestamp }),
            },
          ];
        }),
      };
    });
    if (result.kind === 'unresolved')
      throw new TranscriptReadError(
        'no_transcript',
        `session ${sessionId} has no transcript this daemon can prove is its own`,
      );
    if (result.kind === 'unreadable')
      throw new TranscriptReadError(
        'transcript_unreadable',
        `session ${sessionId} has a proved transcript, but this daemon could not read it`,
      );
    return {
      v: 1,
      ferret: sessionId as FerretId,
      query: text,
      file: result.file,
      matches,
      truncated: result.truncated,
    };
  }

  /**
   * `events` rendered and scrubbed, with every image marker the RENDERER wrote carried through untouched.
   *
   * A marker is digits and a media type this daemon wrote, not content, but a masked value that happens
   * to be a run of digits would still reach into it and leave a handle that names nothing. So the renderer
   * writes a token no secret can equal in each marker's place, and the markers go back after the scrub.
   * Only markers rendered here are lifted: text that merely LOOKS like one — a model can write anything —
   * is scrubbed like every other word, or wrapping a secret in marker syntax would walk it past redaction.
   */
  private async renderRedacted(
    events: readonly TranscriptEvent[],
    options: { readonly partialFirstRecord: boolean },
  ): Promise<string> {
    const markers: string[] = [];
    const lifted = renderTranscript(events, {
      ...options,
      mark: image => {
        markers.push(imageMarker(image));
        return `${NUL}fy-image-${spell(markers.length - 1)}${NUL}`;
      },
    });
    if (markers.length === 0) return await this.redactor.redact(lifted);
    const scrubbed = await this.redactor.redact(lifted);
    return scrubbed.replace(LIFTED_MARKER, (whole, index: string) => markers[unspell(index)] ?? whole);
  }

  /**
   * One page of the session's addressable conversation, strictly after an authenticated cursor.
   *
   * BACKWARD. `backward` reads the page that ENDS at the newest row (`tail`), or at the row a cursor names
   * (`through`, inclusive), and the answer carries `previousCursor`: the token over the row just before the
   * page, which is also the cursor a forward read resumes after, so there is one token kind and one proof
   * (`resumeAfter`). It is null at the start of the conversation. Rows stay oldest-first inside the page; a
   * reader that wants an old item's thread asks for the tail and walks `previousCursor` back until it has
   * what it came for, instead of paging the whole conversation forward to reach its end.
   *
   * WHAT A PAGE PROMISES. Every row names a durable coordinate this daemon minted and carries opaque
   * evidence that the RAW message at that coordinate is still the one this read saw. That second half
   * is what a coordinate alone cannot give: a harness that rewrites a byte range leaves the point
   * valid and the message replaced, and forking the replacement silently is the defect the binding
   * exists to make impossible. Two rows whose redacted display is byte-identical therefore carry
   * different bindings when their raw content differs, so they are independently actionable and a
   * client never has to correlate them by index or by hash.
   *
   * WHY THE CURSOR IS NOT A FINGERPRINT OF THE TRANSCRIPT. It binds only the raw prefix already
   * served, through the last row of the page. So an append after page one does not invalidate page
   * two, a rewrite or truncation strictly AFTER the anchor does not either, and neither does a daemon
   * restart or a change to what the redactor masks. A change at or before the anchor does: that is
   * the conversation this page already claimed, and continuing past it would stitch one page of a
   * conversation onto another.
   *
   * WHAT IT COSTS. The bytes appended since the session's last read — the conversation index folds a
   * transcript once and extends it, so a page of a long session no longer re-reads it from byte zero —
   * plus one fixed-size MAC per served row and one for the cursor, and ONE vault open for the page's
   * scrub. The index is the source's own window and the digest owner's own fold, not a second parser,
   * and nothing re-hashes a whole prefix per row, which is what a chained commitment buys.
   */
  async messages(
    sessionId: string,
    cursor: string | undefined,
    limit: number | undefined,
    backward?: MessageBackwardRead,
  ): Promise<TranscriptPage> {
    const size = boundedLimit(limit, DEFAULT_MESSAGE_PAGE, MAX_MESSAGE_PAGE, 'limit');
    if (backward !== undefined && cursor !== undefined)
      throw new TranscriptReadError(
        'invalid_query',
        'cursor continues forward; it cannot be combined with tail or through',
      );
    // The caller's own query is judged BEFORE a file is read: a cursor this daemon could not have
    // issued is a 400 about the request, never a statement about the session's transcript.
    const anchor = cursor === undefined ? undefined : cursorAnchor(cursor);
    const through = backward?.through === undefined ? undefined : cursorAnchor(backward.through);
    const read = await this.messageSource.read(sessionId);
    if (read.kind === 'unresolved')
      throw new TranscriptReadError(
        'no_transcript',
        `session ${sessionId} has no transcript this daemon can prove is its own`,
      );
    // "COULD NOT READ COMPLETELY", and that last word is load-bearing. One public code answers a file
    // that vanished, a file that would not parse and a record past the per-record bound — each of which
    // the digest owner counts as an incomplete transcript and refuses on rather than returning the rows
    // it did manage to read. An operator told merely that the transcript could not be read will
    // reasonably retry; told it could not be read COMPLETELY, they know a partial page existed and was
    // deliberately withheld, because paging a prefix this daemon cannot prove is whole would offer a fork
    // cut against history that may already be missing. The CODE is unchanged — clients still match
    // `transcript_unreadable` — and the distinction, with the refusal's own reason, is for the human.
    if (read.kind === 'unreadable')
      throw new TranscriptReadError(
        'transcript_unreadable',
        `session ${sessionId} has a proved transcript this daemon could not read completely${
          read.reason === undefined ? '' : `: ${read.reason}`
        }`,
      );
    // A token framed over an undiscovered provenance would be evidence about a snapshot the daemon has
    // since replaced, and it would stop verifying the moment the identity was established. So an
    // unresolved identity is refused here rather than bound into a row a caller would hand back.
    if (read.context.provenance.identity === 'undiscovered')
      throw new TranscriptReadError(
        'no_transcript',
        `session ${sessionId} has no established transcript identity, so no message in it can be addressed`,
      );
    if (read.context.sessionId !== sessionId)
      throw new TranscriptReadError(
        'event_evidence_mismatch',
        `addressable conversation for ${sessionId} was read under context for ${read.context.sessionId}`,
      );
    // The page is rows [start, end). Forward it begins after the cursor; backward it ENDS at the tail, or
    // at the row the `through` cursor names (inclusive — the row a forward cursor would resume after).
    const end =
      backward === undefined
        ? undefined
        : through === undefined
          ? read.rows.length
          : await this.resumeAfter(sessionId, read, through, backward.through ?? '');
    const start =
      end !== undefined
        ? Math.max(0, end - size)
        : anchor === undefined
          ? 0
          : await this.resumeAfter(sessionId, read, anchor, cursor ?? '');
    const served = read.rows.slice(start, end ?? start + size);
    // `nextCursor` is null EXACTLY at the current end, so a client that reaches it, waits and asks
    // again with the previous cursor is asking a question this daemon can answer.
    const last = start + served.length < read.rows.length ? served[served.length - 1] : undefined;
    const before = backward === undefined || start === 0 ? undefined : read.rows[start - 1];
    const issue = async (row: PortableConversationRow | undefined): Promise<string | null> =>
      row === undefined
        ? null
        : await issueSessionTranscriptMessageToken(
            this.messageTokens,
            SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
            read.context,
            row.point,
            row.rawPrefix,
          );
    const [bound, nextCursor, previousCursor] = await Promise.all([
      Promise.all(served.map(async row => await this.boundRow(read.context, row))),
      issue(last),
      issue(before),
    ]);
    // The whole page under ONE vault open, and none for an empty page. Order and cardinality are the
    // caller's slice, and nothing here adds, drops or reorders a row.
    const messages =
      bound.length === 0
        ? []
        : await this.redactor.batch(scrub =>
            bound.map(({ row, point, selectionBinding }) =>
              servedRow(row, point, scrub.text(row.text), selectionBinding),
            ),
          );
    return {
      v: 1,
      ferret: sessionId as FerretId,
      messages,
      nextCursor,
      ...(backward === undefined ? {} : { previousCursor }),
    };
  }

  /**
   * Where to resume from, having proved the anchor is still the row the cursor was issued over.
   *
   * The point inside a cursor is a LOOKUP KEY until the tag says otherwise. It selects a candidate row
   * from this read, and only the MAC — over this session, this incarnation, this pinned provenance,
   * that exact point and the raw-prefix commitment ending at it — decides whether the row is the one
   * the cursor named. An anchor that is no longer present at all and an anchor whose raw prefix has
   * changed are the same public answer, for the same reason every other well-formed mismatch is.
   */
  private async resumeAfter(
    sessionId: string,
    read: Extract<MessageRowReadResult, { readonly kind: 'read' }>,
    anchor: ConversationMessagePoint,
    cursor: string,
  ): Promise<number> {
    const at = read.rows.findIndex(row => sameConversationMessagePoint(row.point, anchor));
    const row = read.rows[at];
    if (row === undefined) throw staleCursor(sessionId);
    const verdict = await verifySessionTranscriptMessageToken(
      this.messageTokens,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
      read.context,
      row.point,
      row.rawPrefix,
      cursor,
    );
    // Anything short of acceptance is stale. The syntax was already admitted above, so a verdict of
    // `malformed` here could only mean the two readers disagree — and failing closed on that is the
    // only safe reading of it.
    if (verdict !== 'accepted') throw staleCursor(sessionId);
    return at + 1;
  }

  /**
   * One row's binding, issued over the RAW content.
   *
   * It is issued independently of the scrub and neither depends on the other's result. Issuing over
   * redacted text would bind evidence to whatever the redactor happens to mask today, so a
   * configuration change would stale every outstanding selection; scrubbing separately keeps the
   * binding a statement about the transcript and the text a statement about what this reader may see.
   */
  private async boundRow(
    context: SessionTranscriptMessageTokenContext,
    row: PortableConversationRow,
  ): Promise<BoundRow> {
    // The digest's portable row type remains optional for compatibility, but the addressable read
    // surface cannot honestly issue a token without an exact block: two blocks in one record would
    // otherwise share it.
    const point = ExactConversationMessagePointSchema.safeParse(row.point);
    if (!point.success)
      throw new TranscriptReadError('transcript_unreadable', 'transcript row has no exact block point');
    const selectionBinding = await issueSessionTranscriptMessageToken(
      this.messageTokens,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
      context,
      point.data,
      row.rawPrefix,
    );
    return { row, point: point.data, selectionBinding };
  }
}

/** A row whose binding is issued and whose display is not yet scrubbed. */
interface BoundRow {
  readonly row: PortableConversationRow;
  readonly point: ExactConversationMessagePoint;
  readonly selectionBinding: string;
}

/** One served row: the durable facts unchanged, the display already scrubbed, the binding as issued. */
function servedRow(
  row: PortableConversationRow,
  point: ExactConversationMessagePoint,
  text: string,
  selectionBinding: string,
): TranscriptMessage {
  return {
    point: formatPoint(point),
    role: row.role,
    text,
    // Omitted rather than sent as null: a row the harness stamped no time on has no time, and
    // inventing one would be a claim about when the agent said it.
    ...(row.timestamp === undefined ? {} : { timestamp: row.timestamp as Instant }),
    selectionBinding,
  };
}

/** One transcript event as the tail carries it, scrubbed; `[]` for a kind the tail does not carry. */
function eventView(event: TranscriptEvent, scrub: TranscriptReadScrub): TranscriptEventView[] {
  const stamped = event.timestamp === undefined ? {} : { timestamp: event.timestamp as Instant };
  switch (event.kind) {
    case 'message':
      return [
        {
          kind: 'message',
          role: event.role,
          text: scrub.text(event.text),
          ...stamped,
          ...(event.inputSource === undefined ? {} : { inputSource: event.inputSource }),
        },
      ];
    case 'tool-call':
      return [
        {
          kind: 'tool-call',
          role: event.role,
          ...stamped,
          call: {
            id: event.call.id,
            name: scrub.text(event.call.name),
            input: scrub.data(event.call.input) as JsonValue,
          },
        },
      ];
    case 'tool-result':
      return [
        {
          kind: 'tool-result',
          role: event.role,
          ...stamped,
          result: {
            callId: event.result.callId,
            content: scrub.data(event.result.content) as JsonValue,
            ...(event.result.text === undefined ? {} : { text: scrub.text(event.result.text) }),
            isError: event.result.isError,
          },
        },
      ];
    default:
      return [];
  }
}
