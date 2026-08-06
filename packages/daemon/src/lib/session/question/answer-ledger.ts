import type { SessionState, StructuredQuestionAnswer } from '@ferretry/protocol';
import type { SessionId } from '../../session-id.ts';

/**
 * THE DURABLE RECEIPT FOR ONE ANSWER OPERATION — the fact that had no owner.
 *
 * An answer is the one session write whose retry is both LIKELY and DESTRUCTIVE. Likely, because
 * `FyApiClient.request` re-sends a POST up to three times on a transport failure and the browser form
 * mints ONE deterministic id for a given rendered question, so a re-click carries the same id as the
 * attempt whose answer was lost. Destructive, because the keys an answer sends are arrow, space and
 * `Enter` into a live selector: sending them twice does not repeat a selection, it moves a cursor
 * that has already moved and submits whatever it lands on.
 *
 * TWO FACTS LIVE HERE, AND THEY ARE NOT THE SAME FACT.
 *
 *   * WHICH RENDERED FORM HAS BEEN ANSWERED is `SessionState.lastAnsweredQuestionToolUseId`, and it
 *     is owned by the state document — written atomically with the deletion of `pendingQuestion`,
 *     and already the exact guard that stops a transcript tail resurrecting an answered tool call.
 *     Nothing here re-defines it; everything here DEFERS to it.
 *   * WHICH REQUEST ID NAMES WHICH OPERATION is this file. A tool-use id is the harness's identity
 *     for a form on a screen; a request id is the caller's own idempotency key. They differ because
 *     their input domains differ, so they get two names rather than one merged one.
 *
 * THE STATE DOCUMENT IS ALWAYS THE AUTHORITY AND THIS RECEIPT IS ALWAYS DERIVED. Two files cannot be
 * written atomically, so the design does not pretend otherwise: the receipt is a cache that
 * reconciliation can always rebuild from the state document, and never the other way round.
 *
 * NO ANSWER IS EVER RE-DRIVEN ON EVIDENCE THIS FILE ALONE PROVIDES. A record that says `accepted`
 * says only that keys MAY have been sent, which is not a fact anything can act on. See
 * `reconcileUnconfirmedAnswer` for the one rule that resolves it and for why the ambiguous case asks
 * a person instead of guessing.
 */

/** The answer payload as the caller spelled it, before the domain normalises anything. */
export interface AnswerRequestPayload {
  readonly toolUseId: string;
  readonly labels: readonly string[];
  readonly other?: string | undefined;
  readonly responses?: readonly string[] | undefined;
  readonly answers?: readonly StructuredQuestionAnswer[] | undefined;
}

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
  /** Refused before any key reached the terminal, so the same id may honestly start over. */
  | 'withdrawn'
  /** No answer key landed, and failure recovery deliberately released this form to prose. */
  | 'failed'
  /** Answer keys may have landed, so recovery released the form but this operation stays closed. */
  | 'quarantined'
  /** A person explicitly cleared the retained warning. Never evidence that the answer landed. */
  | 'acknowledged';

/** A possibly live form. Send/resume must continue treating this as an unknown native modal. */
export const STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND = 'structured-answer-unconfirmed';

/** A form positively released from the pane. This warning is advisory, not an input modal. */
export const STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND = 'structured-answer-released-unconfirmed';

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

/** One request id was presented twice with two different answers. */
export class AnswerRequestConflict extends Error {
  constructor(requestId: string) {
    super(
      `request id ${JSON.stringify(requestId)} was already used for a different answer: one request id names one answer, and replying to this one with the other's result would report an answer nobody gave`,
    );
    this.name = 'AnswerRequestConflict';
  }
}

/** An earlier attempt under this id may have reached the form, and nothing can prove whether it did. */
export class AnswerUnconfirmed extends Error {
  constructor(requestId: string, toolUseId: string, reason?: string) {
    super(
      `an earlier answer under request id ${JSON.stringify(requestId)} reached the rendered form for ${JSON.stringify(toolUseId)} and was never confirmed; it will not be sent again, because repeating those keys would answer whatever the selector has since moved to. Look at the session and answer it there${reason === undefined ? '' : `. Evidence: ${reason}`}`,
      ...(reason === undefined ? [] : [{ cause: new Error(reason) }]),
    );
    this.name = 'AnswerUnconfirmed';
  }
}

/** A drive proved that it sent no answer and then released the form; retries repeat its failure. */
export class AnswerTerminalFailure extends Error {
  constructor(readonly record: AnswerOperationRecord) {
    super(
      record.reason ??
        `answer request ${JSON.stringify(record.requestId)} failed without submitting an answer and released ${JSON.stringify(record.toolUseId)} to prose`,
    );
    this.name = 'AnswerTerminalFailure';
  }
}

/** A settled recovery released structured-question state, so repeating its keys is never valid. */
export class AnswerReleased extends Error {
  constructor(readonly record: AnswerOperationRecord) {
    super(
      record.reason ??
        `answer request ${JSON.stringify(record.requestId)} released ${JSON.stringify(record.toolUseId)} after an unconfirmed attempt; prose may continue, but the original structured answer remains unconfirmed`,
    );
    this.name = 'AnswerReleased';
  }
}

/** A person closed the ambiguity without confirming its answer; this tool must still never re-drive. */
export class AnswerAcknowledged extends Error {
  constructor(readonly record: AnswerOperationRecord) {
    super(
      `answer request ${JSON.stringify(record.requestId)} for ${JSON.stringify(record.toolUseId)} was explicitly acknowledged and will not be driven again; that acknowledgement does not confirm the original structured answer`,
    );
    this.name = 'AnswerAcknowledged';
  }
}

/** A different request already owns this exact rendered form, so a new id cannot authorize keys. */
export class AnswerToolAlreadyHandled extends Error {
  constructor(toolUseId: string, requestId: string, outcome: AnswerOutcome) {
    super(
      `structured question ${JSON.stringify(toolUseId)} is already owned by answer request ${JSON.stringify(requestId)} (${outcome}); a new request id cannot drive the same rendered form`,
    );
    this.name = 'AnswerToolAlreadyHandled';
  }
}

/**
 * The canonical rendering of one answer, as a POSITIONAL list rather than an object.
 *
 * Positional because the two things that make an object fingerprint wrong are key ORDER and the
 * silent disappearance of an `undefined` value, and a list has neither: an absent field is an
 * explicit `null` in a fixed slot. The list is the whole request as the caller SPELLED it, which is
 * the honest thing to compare — see the limitation below.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not normalise the two spellings the wire accepts. The
 * same logical answer can arrive as the legacy `labels`/`other`/`responses` triple or as the lossless
 * `answers` list, and under one request id those two produce different fingerprints and therefore a
 * refusal rather than a replay. That is the fail-closed direction and no real caller reaches it —
 * each client builds its payload from one code path and does not vary it between attempts — but a
 * reader deserves to know the comparison is over the spelling, not over the meaning.
 */
export function answerFingerprint(request: AnswerRequestPayload): string {
  return JSON.stringify([
    request.toolUseId,
    [...request.labels],
    request.other ?? null,
    request.responses === undefined ? null : [...request.responses],
    request.answers === undefined
      ? null
      : request.answers.map(answer =>
          answer.kind === 'other' ? ['other', answer.text] : ['selection', [...answer.labels]],
        ),
  ]);
}

/** What a request carrying this id may do, decided before anything is read from a terminal. */
export type AnswerAdmission =
  /** No prior record, or a prior one that provably sent nothing. Perform the answer. */
  | { readonly kind: 'admit' }
  /** This id already settled. Answer with the CURRENT view; send no keys. */
  | { readonly kind: 'replay' }
  /** This id names a different answer. Refuse, and perform neither. */
  | { readonly kind: 'conflict' }
  /** This id was admitted and never settled. Only the state document can say what happened. */
  | { readonly kind: 'reconcile'; readonly record: AnswerOperationRecord }
  /** This id failed without answering and its form was released; repeat the terminal failure. */
  | { readonly kind: 'failed'; readonly record: AnswerOperationRecord }
  /** This id may have answered and was released safely; never drive it again. */
  | { readonly kind: 'quarantined'; readonly record: AnswerOperationRecord }
  /** A person cleared the ambiguity without confirming an answer; never drive it again. */
  | { readonly kind: 'acknowledged'; readonly record: AnswerOperationRecord };

/**
 * Whether this request may be performed, replayed, or refused.
 *
 * THE FINGERPRINT IS CHECKED FIRST, and before the outcome, because a mismatch is an authorization
 * failure rather than a scheduling one: a request id travels in a header and is chosen by the
 * caller, so answering a second, different payload with the first's success would tell somebody
 * their answer landed when what landed was another one. That refusal has to hold for a settled
 * record and an unsettled one alike.
 */
export function decideAnswerAdmission(input: {
  readonly existing: AnswerOperationRecord | undefined;
  readonly fingerprint: string;
}): AnswerAdmission {
  const { existing, fingerprint } = input;
  if (existing === undefined) return { kind: 'admit' };
  if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
  if (existing.outcome === 'confirmed') return { kind: 'replay' };
  // Withdrawn means the refusal happened before a keystroke, so starting over is not a second answer.
  if (existing.outcome === 'withdrawn') return { kind: 'admit' };
  if (existing.outcome === 'failed') return { kind: 'failed', record: existing };
  if (existing.outcome === 'quarantined') return { kind: 'quarantined', record: existing };
  if (existing.outcome === 'acknowledged') return { kind: 'acknowledged', record: existing };
  return { kind: 'reconcile', record: existing };
}

/** What the answer ledger already knows about one transcript-projected form. */
export type AnswerQuestionEvidence =
  | { readonly kind: 'none' }
  | { readonly kind: 'acknowledged'; readonly record: AnswerOperationRecord }
  | { readonly kind: 'confirmed'; readonly record: AnswerOperationRecord }
  | { readonly kind: 'quarantined'; readonly record: AnswerOperationRecord }
  | { readonly kind: 'released'; readonly record: AnswerOperationRecord }
  | { readonly kind: 'unconfirmed'; readonly record: AnswerOperationRecord };

/**
 * Reconcile one TOOL identity across every request identity that ever named it.
 *
 * An explicit human acknowledgement wins first because it closes every older ambiguity for this
 * tool without claiming an answer landed. Otherwise an unresolved accepted operation wins over
 * every apparently settled row: two request ids may have raced on an older daemon, and one
 * tool-level state stamp cannot prove which one typed. A released quarantine comes next, then a
 * confirmed answer, then a proven non-answer release. Withdrawn rows carry no terminal evidence and
 * deliberately do not hide a still-open question.
 */
export function answerEvidenceForQuestion(
  records: Iterable<AnswerOperationRecord>,
  toolUseId: string,
): AnswerQuestionEvidence {
  const matching = [...records].filter(record => record.toolUseId === toolUseId);
  // Human acknowledgement closes every older ambiguity for the same rendered tool, including an
  // accepted row written under another request id. It never confirms an answer; it only prevents
  // an append-only predecessor from re-minting attention after the explicit clear.
  const acknowledged = matching.find(record => record.outcome === 'acknowledged');
  if (acknowledged !== undefined) return { kind: 'acknowledged', record: acknowledged };
  const accepted = matching.find(record => record.outcome === 'accepted');
  if (accepted !== undefined) return { kind: 'unconfirmed', record: accepted };
  const quarantined = matching.find(record => record.outcome === 'quarantined');
  if (quarantined !== undefined) return { kind: 'quarantined', record: quarantined };
  const confirmed = matching.find(record => record.outcome === 'confirmed');
  if (confirmed !== undefined) return { kind: 'confirmed', record: confirmed };
  const failed = matching.find(record => record.outcome === 'failed');
  return failed === undefined ? { kind: 'none' } : { kind: 'released', record: failed };
}

/**
 * Promote only the accepted receipts whose authoritative state stamp proves completion.
 *
 * The monitor may observe this crash boundary before any caller retries the request. Returning the
 * promoted rows lets its adapter append them durably. Transcript evidence may prove that a modal
 * advanced, but never which answer landed; those accepted rows become released quarantines while
 * an unchanged or unobserved form stays accepted, retains its exact binding when available, and
 * remains input-blocking.
 */
export function reconcileAnswerEvidence(
  records: ReadonlyMap<string, AnswerOperationRecord>,
  state: SessionState,
  observation: {
    readonly activeToolUseId?: string | undefined;
    readonly resolvedToolUseId?: string | undefined;
  } = {},
): {
  readonly records: ReadonlyMap<string, AnswerOperationRecord>;
  readonly settlements: readonly AnswerOperationRecord[];
} {
  const reconciled = new Map(records);
  const settlements: AnswerOperationRecord[] = [];
  for (const record of records.values()) {
    if (record.outcome !== 'accepted') continue;
    const confirmed = reconcileUnconfirmedAnswer({ record, state }) === 'confirmed';
    const observedAdvance =
      observation.resolvedToolUseId === record.toolUseId ||
      (observation.activeToolUseId !== undefined && observation.activeToolUseId !== record.toolUseId);
    if (!confirmed && !observedAdvance) continue;
    const settlement: AnswerOperationRecord = {
      ...record,
      outcome: confirmed ? 'confirmed' : 'quarantined',
      reason: confirmed
        ? 'the answered form was already stamped durably; monitor reconciliation repaired the receipt'
        : `monitor evidence showed ${record.toolUseId} advanced without proving which answer landed; it was quarantined and was not sent again`,
    };
    reconciled.set(record.requestId, settlement);
    settlements.push(settlement);
  }
  return { records: reconciled, settlements };
}

/**
 * What actually became of an operation that was admitted and never settled.
 *
 * ONE RULE, AND IT READS THE STATE DOCUMENT ONLY. `lastAnsweredQuestionToolUseId` is stamped in the
 * same atomic write that removes `pendingQuestion`, so its presence is proof the answer completed and
 * that the receipt is merely behind. Nothing else is proof of anything: a form that is still open
 * might be open because no key landed, or because the keys landed on a form that re-rendered, and a
 * terminal cannot be asked which.
 *
 * SO THE AMBIGUOUS CASE STAYS UNRESOLVED. Until positive release evidence exists, the exact binding
 * and its input block remain; after positive release evidence, a durable advisory asks a person to
 * inspect what may have landed while permitting prose. The alternative — re-sending arrow and
 * `Enter` into a selector whose cursor has already moved — costs an answer nobody chose, silently,
 * on the caller's behalf. A refusal that destroys nothing is always the recoverable error.
 */
export function reconcileUnconfirmedAnswer(input: {
  readonly record: AnswerOperationRecord;
  readonly state: SessionState | undefined;
}): 'confirmed' | 'quarantine' {
  // An unreadable state document is missing evidence, never benign evidence of absence.
  if (input.state === undefined) return 'quarantine';
  return input.state.lastAnsweredQuestionToolUseId === input.record.toolUseId ? 'confirmed' : 'quarantine';
}
