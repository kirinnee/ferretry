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
  | 'withdrawn';

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
  constructor(requestId: string, toolUseId: string) {
    super(
      `an earlier answer under request id ${JSON.stringify(requestId)} reached the rendered form for ${JSON.stringify(toolUseId)} and was never confirmed; it will not be sent again, because repeating those keys would answer whatever the selector has since moved to. Look at the session and answer it there`,
    );
    this.name = 'AnswerUnconfirmed';
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
  | { readonly kind: 'reconcile'; readonly record: AnswerOperationRecord };

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
  return { kind: 'reconcile', record: existing };
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
 * SO THE AMBIGUOUS CASE ASKS A PERSON. Quarantine costs one human glance at a session; the
 * alternative — re-sending arrow and `Enter` into a selector whose cursor has already moved — costs
 * an answer nobody chose, silently, on the caller's behalf. A refusal that destroys nothing is
 * always the recoverable error.
 */
export function reconcileUnconfirmedAnswer(input: {
  readonly record: AnswerOperationRecord;
  readonly state: SessionState | undefined;
}): 'confirmed' | 'quarantine' {
  // An unreadable state document is missing evidence, never benign evidence of absence.
  if (input.state === undefined) return 'quarantine';
  return input.state.lastAnsweredQuestionToolUseId === input.record.toolUseId ? 'confirmed' : 'quarantine';
}
