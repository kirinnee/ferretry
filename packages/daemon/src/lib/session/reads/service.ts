/**
 * The operator READ surface for one session: its durable event history, the live screen its agent is
 * looking at, and the tail of its own harness transcript.
 *
 * WHY THESE THREE TOGETHER. They are the three different kinds of evidence a human uses to answer
 * "what is this agent doing" — what the daemon RECORDED (the journal), what the terminal SHOWS right
 * now (the pane), and what the agent ITSELF wrote (the transcript). Each has a different provenance
 * and a different failure mode, and the whole point of this module is that none of them is allowed
 * to answer with silence when the truthful answer is "I could not tell".
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
 *
 * EVERYTHING THAT LEAVES HERE IS SCRUBBED. All three reads pass through a redactor before they are
 * answered, because these are the surfaces a person actually reads a session on — the screen, the
 * transcript, the journal — and "a secret never appears in your transcripts" is a promise about
 * exactly this code path. The redactor is a one-method port rather than the secret subsystem itself,
 * so this module knows nothing about vaults, and a daemon wired without one gets `NO_REDACTION`,
 * which is honest about having nothing to hide rather than pretending to hide something.
 */

import type { FyEvent } from '@ferretry/protocol';
import type { TranscriptEvent } from '../../transcript/types.ts';
import type { LastSnapshotReader } from '../snapshot/index.ts';

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
  /** A journal page contradicted the requested session or cursor. */
  | 'event_evidence_mismatch';

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

/** Largest event page the replay will serve, matching the protocol client's own ceiling. */
export const MAX_EVENT_PAGE = 1_000;

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
 * Every operator read over one session, in one service because they share exactly one rule: an
 * answer this daemon cannot stand behind is a refusal, never a blank.
 */
export class OperatorReadService {
  constructor(
    private readonly journal: SessionEventJournal,
    private readonly pane: SessionPaneReader,
    private readonly transcript: SessionTranscriptTail,
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
}
