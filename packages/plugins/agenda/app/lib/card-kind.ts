/**
 * TASK OR AGENDA, at a glance: every card the owner swipes is either a TASK (a board card waiting for Done / Not good
 * / Approve, or a gate on one) or an AGENDA item (a question, a decision or a notice). One word and one family decide
 * the chip every surface draws, so the Inbox, Answer quickly and the side panel never disagree. Pure.
 */

import { type AgendaItem, agendaKindLabel, TEST_KIND_LABEL } from '@ferretry/core-asks/contract';
import { gateVerb, isGateItem } from './gate-items.ts';

type CardKindFamily = 'task' | 'agenda';

export interface CardKind {
  readonly family: CardKindFamily;
  readonly word: string;
}

/** A board card waiting to be tried (the to-test rows): the owner's job is to test it. */
export const TASK_CARD_KIND: CardKind = { family: 'task', word: TEST_KIND_LABEL };

/** The word an agenda item carries: the protocol's plain word for its kind (a notice is FYI). */
export const agendaWord = (item: Pick<AgendaItem, 'kind' | 'ask'> & { readonly notice?: true | undefined }): string =>
  agendaKindLabel(item.notice === true ? { kind: 'info' } : item);

/** An Inbox item's kind: a gate is the owner's go-ahead on a task (Test or Approve); everything else is the agenda's. */
export const itemCardKind = (item: AgendaItem): CardKind =>
  isGateItem(item) ? { family: 'task', word: gateVerb(item) } : { family: 'agenda', word: agendaWord(item) };
