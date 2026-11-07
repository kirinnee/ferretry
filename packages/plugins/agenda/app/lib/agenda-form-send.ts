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
} from '../wire/index.ts';
import { useMemo, useRef } from 'react';
import type { InboxAction } from './agenda-answers.ts';
import { agendaForms, type FormPicks, useFormChanges } from './agenda-form-state.ts';

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

/**
 * A composer client whose Send answers the form instead of chatting: the message the composer would have sent is
 * dropped, `send` runs `answer` (which may throw the composer's one error line), and every other method is the target's.
 */
export const withFormSend = <T extends { readonly send: (...args: never[]) => unknown }>(
  client: T,
  answer: () => void,
): T =>
  new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== 'send') return typeof value === 'function' ? value.bind(target) : value;
      return () => {
        answer();
        return Promise.resolve({});
      };
    },
  });

/** What a composer under an open form item is given: its client, and whether Send needs no words. */
export interface FormComposer<T> {
  readonly api: T;
  /** A form item is open: Send answers it even with an empty box. */
  readonly allowEmptySend: boolean;
  /** Bumped when a pick changes, so the "nothing to send" line under the box goes away with it. */
  readonly clearErrorOn?: number;
}

/**
 * THE COMPOSER OF AN OPEN FORM ITEM, the Inbox's and the chat's alike: with `answerForm` its Send answers the form
 * through {@link withFormSend}; without it the client is `api` itself and the composer chats as it always does.
 * `formKey` names the open form's picks.
 */
export const useFormComposer = <T extends { readonly send: (...args: never[]) => unknown } | null>(
  api: T,
  answerForm: (() => void) | undefined,
  formKey: string | undefined,
): FormComposer<T> => {
  const changes = useFormChanges(formKey ?? '');
  const answer = useRef(answerForm);
  answer.current = answerForm;
  const forForm = answerForm !== undefined;
  const client = useMemo(
    () => (api === null || !forForm ? api : withFormSend(api, () => answer.current?.())),
    [api, forForm],
  );
  return forForm
    ? { api: client, allowEmptySend: true, clearErrorOn: changes }
    : { api: client, allowEmptySend: false };
};
