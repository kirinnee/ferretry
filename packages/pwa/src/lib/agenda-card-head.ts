/**
 * WHAT AN OPEN AGENDA ITEM SAYS ABOVE AND AT THE TOP OF ITS CARD, decided once: the title, the one-line description
 * under it, and the QUESTION line the card's options answer. Pure.
 *
 * - The title is the item's own (`--title`), else its ask.
 * - The description is the ask (the item's summary, `subject`) when the title is not already it. An old item whose
 *   title IS its ask falls back to its `why`, when that says something else.
 * - The question is the one question the item asks (`questions[0]`), stated plainly above the options. Without one,
 *   an item that asks something states its ask — unless the description already does, so nothing is said twice.
 */

import type { AgendaItem } from '@ferretry/protocol';
import { agendaCardKind, agendaTitle, hasOwnTitle, singleAgendaQuestion } from '@ferretry/protocol';
import { visibleWhy } from './agenda-inbox.ts';

export interface AgendaCardHead {
  readonly title: string;
  readonly description: string | null;
  readonly question: string | null;
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/** The kinds that ask the owner to choose or answer; a note, a to-do and an input form do not. */
const ASKING = new Set(['choice', 'yesno', 'permission', 'review', 'reply']);

export const agendaCardHead = (item: AgendaItem): AgendaCardHead => {
  const subject = item.subject.trim();
  const title = hasOwnTitle(item) ? agendaTitle(item) : subject;
  const description = subject !== '' && !same(subject, title) ? subject : visibleWhy(item);
  const lone = singleAgendaQuestion(item)?.question.trim() ?? '';
  const asks = item.notice !== true && ASKING.has(agendaCardKind(item));
  const question =
    lone !== '' && !same(lone, description) && !same(lone, title)
      ? lone
      : asks && lone === '' && !same(subject, description) && !same(subject, title)
        ? subject
        : null;
  return { title, description: description === null || description === '' ? null : description, question };
};
