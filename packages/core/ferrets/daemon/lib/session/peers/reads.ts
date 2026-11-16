/**
 * PEER: today's `daemon/src/lib/session/reads/service.ts` — owned by the conversation plugin.
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the host.
 *
 * The stored-event envelope, its projection onto the wire event, and the tail-cache contract, copied verbatim.
 */
import type { FyEvent } from '../../protocol/session.ts';
import type { TranscriptEvent } from './transcript.ts';

/** One journaled session event as storage holds it. */
export interface StoredSessionEvent {
  readonly sequence: number;
  readonly sessionId: string;
  readonly time: string;
  readonly type: string;
  readonly data: unknown;
}

/**
 * Every event the journal holds was written by this daemon, so its source is the daemon: it is taken
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
