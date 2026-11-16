/**
 * PEER: today's `daemon/src/lib/session/question/answer-ledger.ts`, `question/asked.ts` and `question/projection.ts`
 * — owned by the conversation plugin.
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the host.
 *
 * The receipt, ledger, asked-question and projection types are copied verbatim; the projection and reconciliation
 * behaviour is an interface the host supplies ({@link QuestionPolicy}).
 */
import type { PendingQuestion, SessionState } from '../../protocol/session.ts';
import type { SessionId } from '../../session-id.ts';
import type { TranscriptEvent, TranscriptJsonValue, TranscriptQuestion } from './transcript.ts';

// ── today's question/answer-ledger.ts ───────────────────────────────────────────────────────────

/** The fields of a session document that decide what an answer receipt or a projected question means. */
export type QuestionDocument = Pick<
  SessionState,
  'status' | 'pendingQuestion' | 'lastAnsweredQuestionToolUseId' | 'needsHuman' | 'needsHumanKind'
> &
  // The rest of whatever document it was read from: a whole state document is one, unchanged.
  Readonly<Record<string, unknown>>;

/**
 * How far one logical answer operation got. Three states, one per crash boundary.
 *
 * `accepted` is the honest name for "keys may or may not have landed". It is written BEFORE the
 * first keystroke, so a daemon that dies mid-drive leaves evidence rather than silence — and it is
 * never, on its own, permission to try again.
 */
export type AnswerOutcome =
  /** Recorded before a single key was sent. Its true fate is unknown until reconciled. */
  | 'accepted'
  /** The form was driven AND the state document stamped the answered tool id. Settled. */
  | 'confirmed'
  /**
   * Refused before any key reached the terminal, so the same id may honestly start over — or paused
   * on a tabbed form that is still open and was never submitted. Starting over is honest there too: a
   * tabbed drive re-reads every tab and presses `Submit answers` only once the review page lists
   * exactly the requested answers, so a second drive cannot answer anything twice.
   */
  | 'withdrawn'
  /** No answer key landed, and failure recovery deliberately released this form to prose. */
  | 'failed'
  /** Answer keys may have landed, so recovery released the form but this operation stays closed. */
  | 'quarantined'
  /** A person explicitly cleared the retained warning. Never evidence that the answer landed. */
  | 'acknowledged';

/** One answer operation, durably, from the instant it was admitted. */
export interface AnswerOperationRecord {
  /** The caller's idempotency key. Session scope comes from where the ledger is stored. */
  readonly requestId: string;
  /** The rendered form this operation bound to, carried so reconciliation can compare it. */
  readonly toolUseId: string;
  /** The canonical rendering of the answer this id names. A second payload under one id is refused. */
  readonly fingerprint: string;
  readonly acceptedAt: string;
  readonly outcome: AnswerOutcome;
  /** Why a `withdrawn` record is safe to retry, or why an `accepted` one needs a person. */
  readonly reason?: string | undefined;
}

/**
 * The durable boundary, deliberately with no policy in it.
 *
 * Read-modify-write is safe without a lock of its own because every caller holds the session's own
 * serial queue — the same argument the send ledger makes, and the reason a second lock ordering does
 * not have to be reasoned about.
 */
export interface AnswerLedger {
  /** The latest record for one request id on this session, or nothing at all. */
  read(id: SessionId, requestId: string): Promise<AnswerOperationRecord | undefined>;
  /** Every latest request record for this session, so one tool call cannot be driven under two ids. */
  all(id: SessionId): Promise<ReadonlyMap<string, AnswerOperationRecord>>;
  /** Appends one record. The last line written for a request id is the one that counts. */
  append(id: SessionId, record: AnswerOperationRecord): Promise<void>;
}

// ── today's question/asked.ts ───────────────────────────────────────────────────────────────────

export interface AskedQuestion {
  readonly toolUseId: string;
  readonly questions: readonly TranscriptQuestion[];
  readonly input: TranscriptJsonValue;
  /** When the hook wrote the file: after the call was made, before the form was drawn. */
  readonly askedAtMs: number;
}

// ── today's question/projection.ts ──────────────────────────────────────────────────────────────

export type StructuredQuestionProjection =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly question: PendingQuestion }
  | { readonly kind: 'resolved'; readonly toolUseId: string }
  | { readonly kind: 'needs-human'; readonly reason: string };

/**
 * The conversation plugin's question behaviour the observer's question part folds through — today's free
 * functions `projectStructuredQuestion`, `structuredQuestionStatePatch` (`projection.ts`),
 * `reconcileAnswerEvidence` (`answer-ledger.ts`) and `withAskedQuestion` (`asked.ts`), with their signatures.
 */
export interface QuestionPolicy {
  projectStructuredQuestion(events: readonly TranscriptEvent[]): StructuredQuestionProjection;
  structuredQuestionStatePatch(
    current: QuestionDocument,
    projection: StructuredQuestionProjection,
    answerRecords?: Iterable<AnswerOperationRecord>,
  ): Partial<SessionState>;
  reconcileAnswerEvidence(
    records: ReadonlyMap<string, AnswerOperationRecord>,
    state: QuestionDocument,
    observation?: {
      readonly activeToolUseId?: string | undefined;
      readonly resolvedToolUseId?: string | undefined;
    },
  ): {
    readonly records: ReadonlyMap<string, AnswerOperationRecord>;
    readonly settlements: readonly AnswerOperationRecord[];
  };
  withAskedQuestion(events: readonly TranscriptEvent[], asked: AskedQuestion | undefined): readonly TranscriptEvent[];
}
