/**
 * The operator READ surface for one session: its durable event history, the live screen its agent is
 * looking at, the tail of its own harness transcript, and that transcript as ADDRESSABLE ROWS.
 *
 * WHY THESE FOUR TOGETHER. They are the different kinds of evidence a human uses to answer "what is
 * this agent doing" — what the daemon RECORDED (the journal), what the terminal SHOWS right now (the
 * pane), and what the agent ITSELF wrote (the transcript, as text to read and as rows to act on).
 * Each has a different provenance and a different failure mode, and the whole point of this module is
 * that none of them is allowed to answer with silence when the truthful answer is "I could not tell".
 *
 * DAMAGED STATE IS NOT EMPTY STATE, and that rule is the reason every method here can refuse:
 *
 * - A session whose pane is gone has no screen. The legacy daemon captured it anyway and got an
 *   empty string with a zero exit code back, which a human — and every script wrapping it — reads as
 *   a blank but healthy terminal. It is refused here.
 * - A session the daemon cannot prove a transcript file for has no transcript. `SessionTranscriptReader`
 *   deliberately projects that as an empty read, which is right for a question watcher that must not
 *   fail an operation over missing evidence and wrong for an operator asking to SEE the transcript:
 *   they would be shown a blank page and conclude the agent said nothing. So the port that feeds this
 *   module reports resolution separately, and an unresolved session is refused.
 * - An event page is the one read that is honestly empty: the journal is authoritative, it is keyed by
 *   session id, and "no events after sequence N" is a fact rather than an absence of evidence.
 * - A page of ADDRESSABLE ROWS is the same evidence as the tail and a stronger promise about it. A
 *   reader offering "fork from here" needs the coordinate the daemon minted for that exact durable
 *   message; a coordinate taken from a rendered line, a row index or a text hash addresses whichever
 *   message now happens to sit there. So this page is served only from a COMPLETED provenance the
 *   daemon has already persisted, it pages strictly after a cursor it authenticated itself, and every
 *   row carries opaque evidence that its raw content is still the raw content this read saw.
 *
 * EVERYTHING THAT LEAVES HERE IS SCRUBBED. All four reads pass through a redactor before they are
 * answered, because these are the surfaces a person actually reads a session on — the screen, the
 * transcript, the journal — and "a secret never appears in your transcripts" is a promise about
 * exactly this code path. The redactor is a one-method port rather than the secret subsystem itself,
 * so this module knows nothing about vaults, and a daemon wired without one gets `NO_REDACTION`,
 * which is honest about having nothing to hide rather than pretending to hide something.
 */

import type {
  ConversationMessagePoint,
  FyEvent,
  SessionTranscriptMessage,
  SessionTranscriptPage,
} from '@ferretry/protocol';
import type { TranscriptEvent } from '../../transcript/types.ts';
import type { LastSnapshotReader } from '../snapshot/index.ts';
import { type PortableConversationRow, sameConversationMessagePoint } from '../transcript/digest.ts';
import {
  issueSessionTranscriptMessageToken,
  readSessionTranscriptMessageCursor,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
  type SessionTranscriptMessageTokenCodec,
  type SessionTranscriptMessageTokenContext,
  verifySessionTranscriptMessageToken,
} from '../transcript/message-token.ts';

/**
 * Scrubbing, as this surface needs it.
 *
 * Structurally identical to `lib/secrets`'s `TextRedactor` and deliberately declared here: the read
 * surface must not depend on the secret subsystem to serve a transcript, and a daemon that has no
 * secret store still has all three reads.
 */
export interface OperatorReadRedactor {
  redact(text: string): Promise<string>;
  redactData(value: unknown): Promise<unknown>;
}

/** A daemon with nothing to scrub. Its input is its output — a fact, not a fallback. */
export const UNREDACTED: OperatorReadRedactor = {
  redact: async text => text,
  redactData: async value => value,
};

/** Why a read could not be answered. */
export type OperatorReadFailure =
  /** The caller's own query is not one the read can be performed for. */
  | 'invalid_query'
  /** The daemon holds no terminal address for this session, so there is no screen to capture. */
  | 'no_terminal'
  /** The terminal address exists and the pane behind it is gone. */
  | 'pane_dead'
  /** No final frame was captured when the session became terminal. */
  | 'stored_snapshot_unavailable'
  /** The final-frame artifact exists but cannot be read as evidence. */
  | 'stored_snapshot_unreadable'
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
  | 'message_cursor_stale';

export class OperatorReadError extends Error {
  constructor(
    readonly failure: OperatorReadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'OperatorReadError';
  }
}

/**
 * One event exactly as the durable journal holds it.
 *
 * Deliberately NOT the journal's own `SessionEvent`: this module answers in the protocol's
 * vocabulary and must not couple the wire projection to the storage record's schema version.
 */
export interface StoredSessionEvent {
  readonly sequence: number;
  readonly sessionId: string;
  readonly time: string;
  readonly type: string;
  readonly data: unknown;
}

/** The durable per-session event journal, as a replay needs it. */
export interface SessionEventJournal {
  /** Events with a sequence strictly greater than `afterSequence`, in sequence order, at most `limit`. */
  replay(sessionId: string, afterSequence: number, limit: number): Promise<readonly StoredSessionEvent[]>;
}

/** What a live tmux capture of one session's pane produced. */
export interface PaneCapture {
  readonly alive: boolean;
  readonly dead: boolean;
  readonly text: string;
}

/**
 * The pane behind one session.
 *
 * `undefined` means the daemon recorded no terminal address for this session at all, which is a
 * different fact from "the address is recorded and the pane is gone" — the first is a session that
 * never had a terminal, the second is one whose agent has exited. Both refuse, with distinct codes,
 * because an operator acts differently on each.
 */
export interface SessionPaneReader {
  capture(sessionId: string): Promise<PaneCapture | undefined>;
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
export type OperatorMessageReadResult =
  /** The daemon cannot prove which transcript file belongs to this session. */
  | { readonly kind: 'unresolved' }
  /**
   * The exact file was proved, but it could not be read COMPLETELY as evidence.
   *
   * It covers a file that vanished or would not parse and, deliberately, one that is simply too big:
   * a complete read is bounded at 32 MiB (`DEFAULT_MAX_READ_BYTES` in the file transcript source), and
   * a read that stops there reports `source-truncated`, which the digest owner counts as an incomplete
   * transcript and refuses on. That fail-closed chain is why this is one variant rather than three —
   * a shorter-looking conversation is LOST HISTORY, not a valid prefix, and serving its rows would
   * offer a fork cut at a coordinate whose prefix the daemon never actually saw.
   */
  | { readonly kind: 'unreadable' }
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
export interface OperatorMessageSource {
  read(sessionId: string): Promise<OperatorMessageReadResult>;
}

/** Largest event page the replay will serve, matching the protocol client's own ceiling. */
export const MAX_EVENT_PAGE = 1_000;

/** Addressable rows a `messages` page serves when the caller names no limit. */
export const DEFAULT_MESSAGE_PAGE = 200;

/** Largest addressable-row page one `messages` read will serve, matching the client's own ceiling. */
export const MAX_MESSAGE_PAGE = 1_000;

/** Transcript events a `logs` read returns when the caller names no limit. */
export const DEFAULT_LOG_TAIL = 200;

/** Largest transcript tail a single `logs` read will render. */
export const MAX_LOG_TAIL = 2_000;

/**
 * The `source` every replayed event carries.
 *
 * The journal records no author, and it does not need to: every line in it was written by THIS
 * daemon, into a file only this daemon appends to. So `daemon` is a fact about these events rather
 * than a placeholder — unlike the turn, which is genuinely not recorded and is therefore omitted
 * from the envelope rather than invented. See `FyEventSchema`.
 */
export const JOURNAL_EVENT_SOURCE = 'daemon';

/** A stored event in the protocol's envelope. */
export function journalEventToFyEvent(event: StoredSessionEvent): FyEvent {
  return {
    sequence: event.sequence,
    time: event.time,
    sessionId: event.sessionId,
    type: event.type,
    source: JOURNAL_EVENT_SOURCE,
    data: event.data,
  };
}

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

/** The body of one transcript event, as a human reads it. */
function body(event: TranscriptEvent): string {
  switch (event.kind) {
    case 'message':
    case 'reasoning':
      return event.text;
    case 'tool-call':
      return `${event.call.name}(${JSON.stringify(event.call.input)})`;
    case 'tool-result':
      return `${event.result.isError ? 'error ' : ''}${event.result.text ?? JSON.stringify(event.result.content)}`;
    case 'attachment':
      return `${event.attachment.kind}${event.attachment.kind === 'remote-control' ? ` ${event.attachment.url}` : ''}`;
    case 'error':
      return `${event.error.code === undefined ? '' : `${event.error.code}: `}${event.error.message}`;
    case 'usage':
      return `in=${event.usage.inputTokens ?? 0} out=${event.usage.outputTokens ?? 0}`;
    case 'turn':
      return event.state;
    default:
      return JSON.stringify(event.settings);
  }
}

/**
 * A transcript tail as plain text, one event per line.
 *
 * Multi-line bodies are indented under their own header rather than flattened, so a code block an
 * agent wrote is still readable and a reader can still tell where one event ends and the next begins.
 */
export function renderTranscript(events: readonly TranscriptEvent[]): string {
  return events
    .map(event => {
      const when = stamp(event.timestamp);
      const header = `${when === undefined ? '' : `[${when}] `}${event.role}/${event.kind}`;
      const [first = '', ...rest] = body(event).split('\n');
      return [`${header}: ${first}`, ...rest.map(line => `    ${line}`)].join('\n');
    })
    .join('\n');
}

/** A bound the caller supplied, validated against this read's own ceiling. */
function boundedLimit(value: number | undefined, fallback: number, ceiling: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
    throw new OperatorReadError('invalid_query', `${name} must be an integer between 1 and ${ceiling}`);
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
    throw new OperatorReadError('invalid_query', 'cursor is not a well-formed continuation token');
  return anchor;
}

/** The one public answer for every well-formed cursor this read cannot honour. */
function staleCursor(sessionId: string): OperatorReadError {
  return new OperatorReadError(
    'message_cursor_stale',
    `session ${sessionId}'s conversation no longer reads as it did where that page ended`,
  );
}

/**
 * Every operator read over one session, in one service because they share exactly one rule: an
 * answer this daemon cannot stand behind is a refusal, never a blank.
 */
export class OperatorReadService {
  constructor(
    private readonly journal: SessionEventJournal,
    private readonly pane: SessionPaneReader,
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
    private readonly messageSource: OperatorMessageSource,
    /**
     * The daemon-private MAC, as two operations and no key bytes.
     *
     * Separate from the source on purpose: one port answers what the transcript says, the other
     * proves this daemon said it. Merging them would put key custody inside a transcript reader, and
     * this class must be unable to read a key however it is wired.
     */
    private readonly messageTokens: SessionTranscriptMessageTokenCodec,
    private readonly lastSnapshot: LastSnapshotReader = { read: async () => ({ kind: 'absent' }) },
    private readonly redactor: OperatorReadRedactor = UNREDACTED,
  ) {}

  /**
   * One page of a session's durable history.
   *
   * `afterSequence` is that session's OWN sequence, so paging is exact and gapless and cannot drift
   * onto another session's events: the journal is per-session and the id is what selects the file.
   */
  async events(sessionId: string, afterSequence: number, limit: number | undefined): Promise<readonly FyEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new OperatorReadError('invalid_query', 'after must be a non-negative integer');
    const page = boundedLimit(limit, MAX_EVENT_PAGE, MAX_EVENT_PAGE, 'limit');
    const stored = await this.journal.replay(sessionId, afterSequence, page);
    let cursor = afterSequence;
    const page_ = stored.map(event => {
      if (event.sessionId !== sessionId)
        throw new OperatorReadError(
          'event_evidence_mismatch',
          `journal page for ${sessionId} contained evidence for ${event.sessionId}`,
        );
      if (event.sequence <= cursor)
        throw new OperatorReadError(
          'event_evidence_mismatch',
          `journal page for ${sessionId} did not advance after sequence ${cursor}`,
        );
      cursor = event.sequence;
      return journalEventToFyEvent(event);
    });
    // Only `data` is scrubbed. The envelope is this daemon's own — a sequence, an instant, a session
    // id and a type it minted — so nothing in it can hold a value, and passing it through redaction
    // would be spending the work on fields that cannot carry the risk.
    return await Promise.all(
      page_.map(async event => ({ ...event, data: await this.redactor.redactData(event.data) })),
    );
  }

  /**
   * The session's live screen.
   *
   * There is no stored last frame to fall back to — this daemon writes none — so a pane that is gone
   * is reported as gone. That is the whole reason this method can throw: the legacy capture returned
   * an empty string for a dead pane, which is indistinguishable from a healthy blank screen and is
   * the exact false-success shape this migration keeps finding.
   */
  async snapshot(sessionId: string, live = true): Promise<string> {
    if (!live) return await this.redactor.redact(await this.storedSnapshot(sessionId));
    const capture = await this.pane.capture(sessionId);
    if (capture === undefined)
      throw new OperatorReadError('no_terminal', `session ${sessionId} records no terminal this daemon could capture`);
    if (!capture.alive || capture.dead)
      throw new OperatorReadError('pane_dead', `session ${sessionId} has no live pane, so there is no screen to read`);
    return await this.redactor.redact(capture.text);
  }

  /** The durable final frame, only when the daemon actually captured one before terminalization. */
  private async storedSnapshot(sessionId: string): Promise<string> {
    const stored = await this.lastSnapshot.read(sessionId);
    if (stored.kind === 'absent')
      throw new OperatorReadError('stored_snapshot_unavailable', `session ${sessionId} has no captured final frame`);
    if (stored.kind === 'unreadable')
      throw new OperatorReadError(
        'stored_snapshot_unreadable',
        `session ${sessionId} has a final-frame artifact, but this daemon could not read it`,
      );
    return stored.text;
  }

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
      throw new OperatorReadError(
        'no_transcript',
        `session ${sessionId} has no transcript this daemon can prove is its own`,
      );
    if (result.kind === 'unreadable')
      throw new OperatorReadError(
        'transcript_unreadable',
        `session ${sessionId} has a proved transcript, but this daemon could not read it`,
      );
    if (turn === undefined) return await this.redactor.redact(renderTranscript(result.events));
    if (!Number.isSafeInteger(turn) || turn < 0)
      throw new OperatorReadError('invalid_query', 'turn must be a non-negative integer');
    const starts = result.events.flatMap((event, index) =>
      event.kind === 'turn' && event.state === 'started' ? [index] : [],
    );
    const start = starts[turn];
    if (start === undefined)
      throw new OperatorReadError(
        'turn_partition_unavailable',
        `session ${sessionId}'s transcript has no discernible boundary for turn ${turn}`,
      );
    const end = starts[turn + 1] ?? result.events.length;
    return await this.redactor.redact(renderTranscript(result.events.slice(start, end).slice(-tail)));
  }

  /**
   * One page of the session's addressable conversation, strictly after an authenticated cursor.
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
   * WHAT IT COSTS. One complete read per page — the source's own O(n) pass — plus one fixed-size MAC
   * per served row and one for the cursor. There is deliberately no second incremental parser and no
   * re-hashing of whole prefixes per row, which is what a chained commitment buys.
   */
  async messages(
    sessionId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<SessionTranscriptPage> {
    const size = boundedLimit(limit, DEFAULT_MESSAGE_PAGE, MAX_MESSAGE_PAGE, 'limit');
    // The caller's own query is judged BEFORE a file is read: a cursor this daemon could not have
    // issued is a 400 about the request, never a statement about the session's transcript.
    const anchor = cursor === undefined ? undefined : cursorAnchor(cursor);
    const read = await this.messageSource.read(sessionId);
    if (read.kind === 'unresolved')
      throw new OperatorReadError(
        'no_transcript',
        `session ${sessionId} has no transcript this daemon can prove is its own`,
      );
    // "COULD NOT READ COMPLETELY", and that last word is load-bearing. One public code answers three
    // things: a file that vanished, a file that would not parse, and a file whose complete read stopped
    // at the 32 MiB v1 bound and reported `source-truncated` — which the digest owner counts as an
    // incomplete transcript and refuses on rather than returning the rows it did manage to read. An
    // operator told merely that the transcript could not be read will reasonably retry; told it could
    // not be read COMPLETELY, they know a partial page existed and was deliberately withheld, because
    // paging a prefix this daemon cannot prove is whole would offer a fork cut against history that may
    // already be missing. The CODE is unchanged — clients still match `transcript_unreadable` — and this
    // distinction is for the human reading the message.
    if (read.kind === 'unreadable')
      throw new OperatorReadError(
        'transcript_unreadable',
        `session ${sessionId} has a proved transcript this daemon could not read completely`,
      );
    // A token framed over an undiscovered provenance would be evidence about a snapshot the daemon has
    // since replaced, and it would stop verifying the moment the identity was established. So an
    // unresolved identity is refused here rather than bound into a row a caller would hand back.
    if (read.context.provenance.identity === 'undiscovered')
      throw new OperatorReadError(
        'no_transcript',
        `session ${sessionId} has no established transcript identity, so no message in it can be addressed`,
      );
    if (read.context.sessionId !== sessionId)
      throw new OperatorReadError(
        'event_evidence_mismatch',
        `addressable conversation for ${sessionId} was read under context for ${read.context.sessionId}`,
      );
    const start = anchor === undefined ? 0 : await this.resumeAfter(sessionId, read, anchor, cursor ?? '');
    const served = read.rows.slice(start, start + size);
    // `nextCursor` is null EXACTLY at the current end, so a client that reaches it, waits and asks
    // again with the previous cursor is asking a question this daemon can answer.
    const last = start + served.length < read.rows.length ? served[served.length - 1] : undefined;
    const [messages, nextCursor] = await Promise.all([
      Promise.all(served.map(async row => await this.servedRow(read.context, row))),
      last === undefined
        ? null
        : issueSessionTranscriptMessageToken(
            this.messageTokens,
            SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
            read.context,
            last.point,
            last.rawPrefix,
          ),
    ]);
    return { v: 1, sessionId, messages, nextCursor };
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
    read: Extract<OperatorMessageReadResult, { readonly kind: 'read' }>,
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
   * One served row: the durable facts unchanged, the display scrubbed, and the binding issued over the
   * RAW content.
   *
   * The two happen independently and neither depends on the other's result. Issuing over redacted
   * text would bind evidence to whatever the redactor happens to mask today, so a configuration
   * change would stale every outstanding selection; scrubbing after issuance keeps the binding a
   * statement about the transcript and the text a statement about what this reader may see. Order and
   * cardinality are the caller's slice, and nothing here adds, drops or reorders a row.
   */
  private async servedRow(
    context: SessionTranscriptMessageTokenContext,
    row: PortableConversationRow,
  ): Promise<SessionTranscriptMessage> {
    const [selectionBinding, text] = await Promise.all([
      issueSessionTranscriptMessageToken(
        this.messageTokens,
        SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
        context,
        row.point,
        row.rawPrefix,
      ),
      this.redactor.redact(row.text),
    ]);
    return {
      point: row.point,
      role: row.role,
      text,
      // Omitted rather than sent as null: a row the harness stamped no time on has no time, and
      // inventing one would be a claim about when the agent said it.
      ...(row.timestamp === undefined ? {} : { timestamp: row.timestamp }),
      selectionBinding,
    };
  }
}
