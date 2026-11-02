/**
 * TASK OR AGENDA, at a glance: every card the owner swipes is either a TASK (a board card waiting for Done / Not good
 * / Approve, or a gate on one) or an AGENDA item (a question, a decision or a notice). One word and one family decide
 * the chip every surface draws, so the Inbox, Answer quickly and the side panel never disagree. Pure.
 */

import type { AgendaItem } from '@ferretry/protocol';
import { agendaCardKind } from '@ferretry/protocol';
import { isGateItem } from './gate-items.ts';

type CardKindFamily = 'task' | 'agenda';

export interface CardKind {
  readonly family: CardKindFamily;
  readonly word: string;
}

export const TASK_CARD_KIND: CardKind = { family: 'task', word: 'Task' };

/** The word an agenda item carries: Question, Decision, Info, or a to-do the owner does by hand. */
export const agendaWord = (item: Pick<AgendaItem, 'kind' | 'ask'> & { readonly notice?: true | undefined }): string => {
  if (item.notice === true) return 'Info';
  switch (agendaCardKind(item)) {
    case 'info':
      return 'Info';
    case 'yesno':
    case 'permission':
    case 'choice':
    case 'review':
      return 'Decision';
    case 'task':
      return 'To do';
    case 'reply':
    case 'form':
    case 'input':
      return 'Question';
  }
};

/** An Inbox item's kind: a gate is the owner's go-ahead on a task; everything else is the agenda's. */
export const itemCardKind = (item: AgendaItem): CardKind =>
  isGateItem(item) ? TASK_CARD_KIND : { family: 'agenda', word: agendaWord(item) };
