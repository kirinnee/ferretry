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
import { composerQuoteTarget, type ExistingAttachment, type ExistingAttachmentOutcome } from './quote.ts';
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
 * Whether this exact reference is already a token in the draft.
 *
 * Compared as CANONICAL tokens of parsed references, so `%TERMINAL:ab12` and
 * `%terminal:ab12` count as one, and a token welded inside a longer word — which
 * `findReferences` never reports — is not a match at all.
 */
export const draftCarriesReference = (draft: string, reference: Reference): boolean => {
  const wanted = referenceToken(reference);
  return wanted !== null && findReferences(draft).some(match => referenceToken(match.reference) === wanted);
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
  if (draftCarriesReference(draft, reference)) return 'duplicate';
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

/**
 * What the + on an attachment tile did.
 *
 *   `referenced`  the token is in the draft at the caret; `chip` says what happened to the file.
 *   `no-composer` no message box is open for that scope, so nothing was touched.
 *   `rejected`    the file's name is not one the attachment grammar can write.
 */
export type ReferenceAttachmentOutcome =
  | { readonly state: 'referenced'; readonly chip: ExistingAttachmentOutcome | 'unsupported' }
  | { readonly state: 'no-composer' }
  | { readonly state: 'rejected' };

/**
 * The attachment's reference: the FILE goes back into the message box as a chip — by its existing id, never
 * re-uploaded — and the token `%attachment:<name>` is written at the caret.
 *
 * The chip is asked for first and the token written regardless: a composer at its attachment limit still gets
 * the reference, because the token is what the sentence needs, and the ferret can open a file the earlier
 * message already handed it. The name is the file's DELIVERED name (the last segment of the path the ferret
 * was given), which is why the caller passes the tile's own filename rather than the uploaded one.
 */
export const referenceAttachmentInComposer = (
  file: ExistingAttachment,
  scope: DaemonSessionScope,
): ReferenceAttachmentOutcome => {
  const token = referenceToken({ kind: 'attachment', name: file.filename });
  if (token === null) return { state: 'rejected' };
  const target = composerQuoteTarget(scope);
  if (target === null || target.insertAtCaret === undefined) return { state: 'no-composer' };
  const chip = target.attachExisting === undefined ? 'unsupported' : target.attachExisting(file);
  target.insertAtCaret(token);
  return { state: 'referenced', chip };
};

/**
 * The text after \`inserted\` replaces \`[start, end)\` of \`draft\`: a space before when the words ahead of it
 * need one, a space after unless one already follows, so the token keeps the left and right boundaries the
 * grammar needs and the next word the reader types starts fresh. Returns the new draft and the caret.
 */
export const insertAtSelection = (
  draft: string,
  start: number,
  end: number,
  inserted: string,
): { readonly draft: string; readonly caret: number } => {
  const from = Math.max(0, Math.min(start, draft.length));
  const to = Math.max(from, Math.min(end, draft.length));
  const before = draft.slice(0, from);
  const after = draft.slice(to);
  const lead = before === '' || /\s$/u.test(before) ? '' : ' ';
  const trail = /^\s/u.test(after) ? '' : ' ';
  const written = `${lead}${inserted}${trail}`;
  // The caret goes after the space we added, or after the token when a space already follows it.
  const caret = from + lead.length + inserted.length + (trail === '' ? 0 : 1);
  return { draft: `${before}${written}${after}`, caret };
};
