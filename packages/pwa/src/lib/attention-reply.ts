/**
 * REPLYING IS ANSWERING. An agenda item is answered from the ferret's NORMAL composer: what the owner types
 * goes as a normal message that names the items it is about (the "re:" chips, as `!A5` references), and a
 * picked option carries the typed text as its note. These are the pure decisions behind that; the composer and
 * the card do the drawing.
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

/**
 * A message with the items its "re:" chips name: each as a `!A5` reference at the front, in chip order, each once
 * (one already typed is not repeated). Nothing is guessed — only the chips the owner added.
 */
export const withReferences = (text: string, ids: readonly AttentionItem['id'][]): string => {
  const missing = [...new Set(ids)].filter(id => !new RegExp(`(?:^|\\s)!${id}(?=$|[\\s.,;:!?)])`, 'u').test(text));
  return missing.length === 0 ? text : `${missing.map(id => `!${id}`).join(' ')} ${text}`;
};
