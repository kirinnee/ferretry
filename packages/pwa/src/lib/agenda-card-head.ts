/**
 * WHAT AN OPEN AGENDA ITEM SAYS ABOVE AND AT THE TOP OF ITS CARD, decided once: the title, the one-line description
 * under it, and the QUESTION line the card's options answer. Pure.
 *
 * - The title is the item's own (`--title`), else its ask.
 * - The description is the ask (the item's summary, `subject`) when the title is not already it. An old item whose
 *   title IS its ask falls back to its `why`, when that says something else.
 * - The question is the one question the item asks (`questions[0]`), stated plainly above the options. Without one,
 *   the ask is already said — in the title or the description — so nothing is said twice.
 */

import type { AgendaItem } from '@ferretry/protocol';
import { agendaTitle, hasOwnTitle, singleAgendaQuestion } from '@ferretry/protocol';
import { visibleWhy } from './agenda-inbox.ts';

export interface AgendaCardHead {
  readonly title: string;
  readonly description: string | null;
  readonly question: string | null;
}

const same = (a: string | null, b: string): boolean => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

export const agendaCardHead = (item: AgendaItem): AgendaCardHead => {
  const subject = item.subject.trim();
  const title = hasOwnTitle(item) ? agendaTitle(item) : subject;
  const description = subject !== '' && !same(subject, title) ? subject : visibleWhy(item);
  const lone = singleAgendaQuestion(item)?.question.trim() ?? '';
  const question = lone !== '' && !same(description, lone) && !same(title, lone) ? lone : null;
  return { title, description, question };
};
