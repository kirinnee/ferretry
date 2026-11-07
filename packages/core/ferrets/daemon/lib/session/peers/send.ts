/**
 * PEER: today's `daemon/src/lib/session/send/tracker.ts`, `send/view.ts` and `send/service.ts` — owned by the
 * conversation plugin.
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the host.
 *
 * The send-evidence types are copied verbatim; the transcript evidence reader (`TranscriptSendEvidence`) and the send
 * service are interfaces the host supplies.
 */
import type { SessionId } from '../../session-id.ts';
import type {
  ObservedHumanInput,
  TranscriptTarget,
  TranscriptWindow,
  TranscriptWindowStart,
} from './transcript.ts';

// ── today's send/tracker.ts ─────────────────────────────────────────────────────────────────────

export interface SendEvidenceReading {
  readonly readable: boolean;
  /** The session has no transcript the daemon can prove is its own, which no amount of waiting fixes. */
  readonly unbound?: true;
  /**
   * Not unreadable — still reading. A look reads a bounded amount and keeps its place, so a huge
   * transcript is read across several looks; until the window reaches the end, absence is not yet
   * provable, and that is a reason to look again, never to call a message unconfirmed.
   */
  readonly catchingUp?: true;
  readonly inputs: readonly ObservedHumanInput[];
}

/** The transcript side: what the harness has recorded the agent receiving or holding. */
export interface SendEvidenceSource {
  /**
   * What the transcript holds from `since` on — the acceptance of the oldest send being looked for,
   * before which nothing can prove one. A source may read less than the whole file because of it.
   */
  read(id: SessionId, since: string): Promise<SendEvidenceReading>;
}

// ── today's send/view.ts ────────────────────────────────────────────────────────────────────────

/** The transcript reads `TranscriptSendEvidence` takes (today's `Pick<SessionTranscriptReader, 'window' | 'file'>`). */
export interface SendEvidenceTranscriptReader {
  window(target: TranscriptTarget, start: TranscriptWindowStart): Promise<TranscriptWindow | undefined>;
  file(target: TranscriptTarget): Promise<string | undefined>;
}

/** The send tracker's evidence over one transcript (today's `TranscriptSendEvidence` class): read by any session id string. */
export interface TranscriptSendEvidence extends SendEvidenceSource {
  read(id: string, since: string): Promise<SendEvidenceReading>;
}

/**
 * The send tracker's evidence over one transcript, holding a window open between looks — today's
 * `TranscriptSendEvidence` class. Built by `new TranscriptSendEvidence(target, reader)` today.
 */
export type TranscriptSendEvidenceFactory = (
  target: (id: string) => Promise<TranscriptTarget | undefined>,
  reader: SendEvidenceTranscriptReader,
) => TranscriptSendEvidence;

// ── today's send/service.ts ─────────────────────────────────────────────────────────────────────

/** A send as the session code asks for one (today's `SendMessageRequest`, trimmed to the fields used here). */
export interface SendMessageRequest {
  readonly id: SessionId;
  /** The caller's idempotency key. */
  readonly sendId: string;
  readonly message: string;
}

/** The send slice (today's `SessionSendService`, trimmed to `send`; its outcome is not read here). */
export interface SessionSendService {
  send(request: SendMessageRequest): Promise<unknown>;
}
