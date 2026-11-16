/**
 * THE ONE SEND OF A FORM CARD: the picks on the card and the words in the composer become one answer, `{ kind: 'form' }`,
 * which the daemon records by field id and delivers to the ferret as the numbered answer (`formWords`).
 *
 * - The composer's text answers the form's `text` field; a form with no such field sends it as the answer's note.
 * - EVERY FIELD IS OPTIONAL (&F922): Send goes through with any subset, at once — no field is asked about first. What
 *   the owner skipped reads `(skipped)` in the one numbered answer the ferret receives (`formWords`).
 * - Words with nothing picked still go, as a plain reply to the form's ask (`{ kind: 'open-question' }`, a form's ask
 *   kind): the shape every app and daemon already takes, so an older one never meets a form answer with no field.
 * - Nothing picked and nothing typed is not an answer; Send says so instead.
 */

import {
  type AgendaFormAnswer,
  type AgendaFormField,
  type AgendaItem,
  formAnswerOf,
  formFieldName,
  formValues,
} from '@ferretry/core-asks/contract';
import type { InboxAction } from './agenda-answers.ts';
import { agendaForms, type FormPicks } from './agenda-form-state.ts';

/** The label a sent form carries when nothing on the card was picked (only the reply box answered it). */
const FORM_SENT_LABEL = 'Form';

/**
 * What a sent form says it answered, in the undo toast and the chat's "sent" line: each field picked on the card,
 * "Region: US · Alerts: Page, Mail". The typed words are the conversation's own message, so they are not repeated.
 */
export const formSentSummary = (fields: readonly AgendaFormField[], answers: readonly AgendaFormAnswer[]): string => {
  const picked = fields.flatMap(field => {
    if (field.type === 'text') return [];
    const values = formValues(formAnswerOf(answers, field));
    return values.length === 0 ? [] : [`${formFieldName(field)}: ${values.join(', ')}`];
  });
  return picked.length === 0 ? FORM_SENT_LABEL : picked.join(' · ');
};

/** How many of the fields answered ON THE CARD are answered so far; the reply box's own field is not counted. */
export const formProgress = (
  fields: readonly AgendaFormField[],
  picks: FormPicks,
): { readonly answered: number; readonly total: number } => {
  const onCard = fields.filter(field => field.type !== 'text');
  return { answered: onCard.filter(field => (picks[field.id] ?? []).length > 0).length, total: onCard.length };
};

/** The answers a form has so far: one per field the owner filled in, in the form's order. */
export const formAnswersFrom = (
  fields: readonly AgendaFormField[],
  picks: FormPicks,
  typed: string,
): readonly AgendaFormAnswer[] =>
  fields.flatMap((field): AgendaFormAnswer[] => {
    if (field.type === 'text') return typed.trim() === '' ? [] : [{ id: field.id, picked: typed.trim() }];
    const values = picks[field.id] ?? [];
    if (values.length === 0) return [];
    return [{ id: field.id, picked: field.type === 'many' ? [...values] : (values[0] as string) }];
  });

export type FormSendPlan =
  | { readonly kind: 'send'; readonly action: InboxAction }
  | { readonly kind: 'nothing'; readonly message: string };

/** What Send does now: answer with whatever is filled in (any subset), or say there is nothing to send. */
export const planFormSend = (item: Pick<AgendaItem, 'fields'>, picks: FormPicks, typed: string): FormSendPlan => {
  const fields = item.fields ?? [];
  const answers = formAnswersFrom(fields, picks, typed);
  if (answers.length === 0 && typed.trim() === '')
    return { kind: 'nothing', message: 'Pick an answer or type something before you send the form.' };
  if (answers.length === 0)
    return {
      kind: 'send',
      action: { kind: 'respond', label: FORM_SENT_LABEL, response: { kind: 'open-question', answer: typed.trim() } },
    };
  const hasTextField = fields.some(field => field.type === 'text');
  const note = hasTextField || typed.trim() === '' ? {} : { note: typed.trim() };
  return {
    kind: 'send',
    action: {
      kind: 'respond',
      label: formSentSummary(fields, answers),
      response: { kind: 'form', answers: [...answers] },
      ...note,
    },
  };
};

/**
 * Sends the form `key` names through `schedule` (the Inbox's undo window), or throws the plain sentence the composer
 * shows under its box: that there is nothing to send.
 */
export const sendForm = (
  key: string,
  item: Pick<AgendaItem, 'fields'>,
  typed: string,
  schedule: (action: InboxAction) => void,
): void => {
  const plan = planFormSend(item, agendaForms.picks(key, item.fields ?? []), typed);
  if (plan.kind === 'nothing') throw new Error(plan.message);
  schedule(plan.action);
  agendaForms.forget(key);
};
