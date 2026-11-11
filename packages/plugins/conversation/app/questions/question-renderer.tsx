/**
 * THE `ask:question` RENDERER: a ferret's question, drawn wherever an ask of source `question` is shown (the Agenda's
 * answer row; the chat shows the same form above its composer). With the ferret it belongs to it is the answer form
 * (app action `question.answer`, `POST /v1/ferrets/:ferretId/answer`); without one it is the read-only card, because an
 * answer must name its ferret and a renderer never guesses one.
 */

import { type Question, QuestionSchema } from '../../contract/index.ts';
import { useConversationClient, useConversationDaemon } from '../client.ts';
import { QuestionCard } from './question-card.tsx';
import { pendingQuestionOf, QuestionForm, questionAnswerApi } from './question-form.tsx';

/** What an ask hands the renderer: the question itself, or the ask around it (`ref`, `source.ref`), and its ferret. */
export interface QuestionAskValue {
  readonly question: Question;
  readonly ferret?: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** Reads the renderer's value; `undefined` when it holds no question this plugin wrote. */
export const questionAskValue = (value: unknown): QuestionAskValue | undefined => {
  const outer = record(value);
  const candidates = [outer?.ref, record(outer?.source)?.ref, outer?.question, value];
  for (const candidate of candidates) {
    const parsed = QuestionSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const ferret = outer?.ferret;
    return { question: parsed.data, ...(typeof ferret === 'string' && ferret !== '' ? { ferret } : {}) };
  }
  return undefined;
};

export function QuestionRenderer({ value }: { readonly value: unknown }) {
  const client = useConversationClient();
  const daemon = useConversationDaemon();
  const ask = questionAskValue(value);
  if (ask === undefined) return null;
  const { question, ferret } = ask;
  if (ferret === undefined || daemon === undefined)
    return (
      <QuestionCard
        questions={[
          {
            ...(question.header === undefined ? {} : { header: question.header }),
            question: question.text,
            options: question.options,
            multiSelect: question.multiple,
          },
          ...(question.more ?? []).map(more => ({
            ...(more.header === undefined ? {} : { header: more.header }),
            question: more.text,
            options: more.options,
            multiSelect: more.multiple,
          })),
        ]}
      />
    );
  return (
    <QuestionForm
      api={questionAnswerApi(client)}
      daemon={daemon}
      ferretId={ferret}
      question={pendingQuestionOf(question)}
    />
  );
}
