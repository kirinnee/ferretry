/**
 * THE ONE SEND OF A FORM CARD: the picks on the card and the words in the composer become one answer, `{ kind: 'form' }`,
 * which the daemon records by field id and delivers to the ferret as the numbered answer (`formWords`).
 *
 * - The composer's text answers the form's `text` field; a form with no such field sends it as the answer's note.
 * - A required field left empty is asked about ONCE: the first Send says which, the next Send as it stands goes through.
 * - Nothing picked and nothing to send is not a form answer; Send says so instead.
 */

import {
  type AgendaFormAnswer,
  type AgendaFormField,
  type AgendaItem,
  formFieldName,
  formMissing,
} from '@ferretry/protocol';
import { useMemo, useRef } from 'react';
import type { InboxAction } from './agenda-answers.ts';
import { agendaForms, type FormPicks, useFormChanges } from './agenda-form-state.ts';

/** The label the sent form carries in the undo toast and in history. */
const FORM_SENT_LABEL = 'Form';

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
  | { readonly kind: 'ask'; readonly message: string; readonly signature: string }
  | { readonly kind: 'nothing'; readonly message: string };

/** What Send does now: answer, ask once about the empty fields, or say there is nothing to send. */
export const planFormSend = (
  item: Pick<AgendaItem, 'fields'>,
  picks: FormPicks,
  typed: string,
  askedAbout: string | undefined,
): FormSendPlan => {
  const fields = item.fields ?? [];
  const answers = formAnswersFrom(fields, picks, typed);
  if (answers.length === 0) return { kind: 'nothing', message: 'Fill in at least one field before you send the form.' };
  const missing = formMissing(fields, answers);
  const signature = missing.map(field => field.id).join(',');
  if (missing.length > 0 && askedAbout !== signature) {
    const names = missing.map(field => `${String(fields.indexOf(field) + 1)}. ${formFieldName(field)}`).join(', ');
    return {
      kind: 'ask',
      signature,
      message: `Not answered yet: ${names}. Press Send again to send it as it is.`,
    };
  }
  const hasTextField = fields.some(field => field.type === 'text');
  const note = hasTextField || typed.trim() === '' ? {} : { note: typed.trim() };
  return {
    kind: 'send',
    action: { kind: 'respond', label: FORM_SENT_LABEL, response: { kind: 'form', answers: [...answers] }, ...note },
  };
};

/**
 * Sends the form `key` names through `schedule` (the Inbox's undo window), or throws the plain sentence the composer
 * shows under its box: the one question about empty fields, or that there is nothing to send.
 */
export const sendForm = (
  key: string,
  item: Pick<AgendaItem, 'fields'>,
  typed: string,
  schedule: (action: InboxAction) => void,
): void => {
  const plan = planFormSend(item, agendaForms.picks(key, item.fields ?? []), typed, agendaForms.asked(key));
  if (plan.kind === 'nothing') throw new Error(plan.message);
  if (plan.kind === 'ask') {
    agendaForms.markAsked(key, plan.signature);
    throw new Error(plan.message);
  }
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
  /** Bumped when a pick changes, so the "Not answered yet" line under the box goes away with it. */
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
