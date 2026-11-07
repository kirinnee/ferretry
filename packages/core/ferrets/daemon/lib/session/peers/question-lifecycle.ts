/**
 * PEER: today's `packages/daemon/src/lib/session/question/answer-ledger.ts` (owner: conversation) — the two agenda
 * kinds the resume policy reads. A copy of its own: the observer helper's `peers/question.ts` is a separate file.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */

/** A possibly live form. Send/resume must continue treating this as an unknown native modal. */
export const STRUCTURED_ANSWER_UNCONFIRMED_AGENDA_KIND = 'structured-answer-unconfirmed';

/** A form positively released from the pane. This warning is advisory, not an input modal. */
export const STRUCTURED_ANSWER_RELEASED_AGENDA_KIND = 'structured-answer-released-unconfirmed';
