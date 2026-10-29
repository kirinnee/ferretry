/**
 * REPLYING IS ANSWERING. An open Attention item is answered from the ferret's NORMAL composer: what the owner
 * types goes as a normal message referencing the item ("Replying to: <title>"), and a picked option carries the
 * typed text as its note. These are the pure decisions behind that; the composer and the card do the drawing.
 */

import type { AttentionItem } from '@ferretry/protocol';
import type { InboxAction } from './attention-answers.ts';

/**
 * An answer picked on a card (or an ask in the chat) with the composer's text riding along: the text becomes the
 * answer's note — an option's note, a dismissal's reason. A text-carrying answer that already has its words, or a
 * blank composer, leaves the action as it was.
 */
export const withComposerNote = (action: InboxAction, text: string): InboxAction => {
  const typed = text.trim();
  if (typed === '' || action.kind === 'discuss') return action;
  if (action.kind === 'respond' && action.response.kind !== 'multiple-choice' && action.response.kind !== 'permission')
    return action;
  const note = action.note === undefined || action.note.trim() === '' ? typed : `${action.note} — ${typed}`;
  return { ...action, note };
};

/** The item the composer replies to by default: the newest open one of this conversation, or none. */
export const defaultReplyTarget = (open: readonly AttentionItem[]): AttentionItem | null =>
  open.reduce<AttentionItem | null>(
    (newest, item) => (newest === null || item.waitingSince > newest.waitingSince ? item : newest),
    null,
  );
