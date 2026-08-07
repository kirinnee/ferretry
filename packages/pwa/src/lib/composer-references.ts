/**
 * Add to chat — put a proved reference into one session's composer draft.
 *
 * This is the other half of addressing. Autocomplete serves the reader who is
 * already typing; Add to chat serves the reader who is LOOKING at a surface — a
 * terminal in the pane, a file in the tree — and wants to point an agent at
 * exactly that one without transcribing a twelve-character id by hand. A
 * mistranscribed id is not a typo here: it addresses a different shell.
 *
 * IT REUSES THE COMPOSER REGISTRY rather than inventing a delivery path.
 * `quote.ts` already publishes every mounted composer under its full
 * `(daemonId, sessionId)` scope, precisely because retained background panes keep
 * their composers mounted and two panes can belong to different daemons. A
 * reference delivered by guessing "the foreground composer" could land in another
 * daemon's session, which for a surface reference would then be addressed by a
 * session that never owned it.
 *
 * THE TOKEN IS FORMATTED, NEVER CONCATENATED. `formatReference` is the one
 * renderer of canonical tokens and it refuses anything the grammar would not
 * accept, so a caller cannot deliver `%terminal:bad key` into a draft where it
 * would sit as unprovable prose.
 */

import type { DaemonSessionScope } from './daemon-scope.ts';
import { composerQuoteTarget } from './quote.ts';
import { findReferences, formatReference, type Reference } from './references.ts';

/**
 * What happened, honestly.
 *
 * `no-composer` means no composer is mounted for that scope — the reader is on
 * another session, or a structured question replaced the composer. `duplicate`
 * means the draft already carries this exact reference: repeating it says nothing
 * new and reads as two surfaces. `rejected` means the reference is not one the
 * grammar can write down at all.
 */
export type AddReferenceOutcome = 'added' | 'duplicate' | 'no-composer' | 'rejected';

/** The canonical token, or null when the grammar refuses the reference. */
export const referenceToken = (reference: Reference): string | null => {
  try {
    return formatReference(reference);
  } catch {
    return null;
  }
};

/**
 * Whether this effective reference target is already a token in the draft.
 *
 * Compared as CANONICAL tokens of parsed references, so `%TERMINAL:ab12` and
 * `%terminal:ab12` count as one, and a token welded inside a longer word — which
 * `findReferences` never reports — is not a match at all. Tasks additionally use
 * the composer's session: bare `&F12` and `&F12@{this-session}` are the same
 * target, while two foreign owners remain distinct.
 */
export const draftCarriesReference = (draft: string, reference: Reference, scope?: DaemonSessionScope): boolean => {
  const wanted = referenceToken(reference);
  if (wanted === null) return false;
  return findReferences(draft).some(match => {
    if (reference.kind !== 'task' || match.reference.kind !== 'task' || scope === undefined)
      return referenceToken(match.reference) === wanted;
    return (
      match.reference.id.toUpperCase() === reference.id.toUpperCase() &&
      (match.reference.sessionId ?? scope.sessionId) === (reference.sessionId ?? scope.sessionId)
    );
  });
};

/**
 * The draft after appending a reference token.
 *
 * Appended, never prepended and never clobbering: the reader's sentence is the
 * point and the reference is what they are pointing at. One space before, one
 * after, so the next thing they type is a fresh word and the token keeps the
 * right boundary the grammar needs.
 */
export const composeReferenceDraft = (draft: string, token: string): string =>
  draft.trim() === '' ? `${token} ` : `${draft.replace(/\s*$/u, '')} ${token} `;

/**
 * Delivers one reference into the composer for exactly this scope.
 *
 * There is no default scope on purpose. A quoted selection comes FROM the
 * foreground pane, so it can default to it; a reference comes from a surface that
 * already knows which daemon and session it belongs to, and a default would be
 * the one way this could deliver a session's terminal into another session's
 * draft.
 */
export const addReferenceToComposer = (reference: Reference, scope: DaemonSessionScope): AddReferenceOutcome => {
  const token = referenceToken(reference);
  if (token === null) return 'rejected';
  // The registry KEYS a target by the scope the target itself publishes, so a
  // lookup can only ever answer with a composer belonging to this exact daemon
  // and session. There is deliberately no second scope check here: it would be
  // unreachable by construction, and an unreachable guard is a claim about a
  // danger the code has already eliminated.
  const target = composerQuoteTarget(scope);
  if (target === null) return 'no-composer';
  const draft = target.draft();
  if (draftCarriesReference(draft, reference, scope)) return 'duplicate';
  target.replaceDraft(composeReferenceDraft(draft, token));
  return 'added';
};

/** The sentence a surface shows after an Add to chat. Kept here so every caller
 *  reports the same outcome in the same words. */
export const addReferenceMessage = (outcome: AddReferenceOutcome, token: string): string => {
  switch (outcome) {
    case 'added':
      return `Added ${token} to this session's message.`;
    case 'duplicate':
      return `${token} is already in this message.`;
    case 'no-composer':
      return 'No message box is open for this session, so there is nowhere to add it.';
    case 'rejected':
      return 'That reference cannot be written down, so it was not added.';
  }
};
