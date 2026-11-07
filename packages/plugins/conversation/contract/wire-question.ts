/** A question a ferret asks mid-turn, and its answer (today's `session.ts` answer schemas). */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

export const StructuredQuestionAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('selection'), labels: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ kind: z.literal('other'), text: z.string().trim().min(1) }),
]);
export type StructuredQuestionAnswer = z.infer<typeof StructuredQuestionAnswerSchema>;

/** `POST /v1/ferrets/:ferret/answer` body. Owner-only (`caller: 'person'`): a ferret never answers itself. */
export const AnswerRequestSchema = z.strictObject({
  toolUseId: z.string().min(1),
  labels: z.array(z.string().min(1)),
  other: z.string().optional(),
  responses: z.array(z.string()).optional(),
  answers: z.array(StructuredQuestionAnswerSchema).min(1).optional(),
});
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

/** `state/conversation/<ferret>/question.json`: the question the ferret is waiting on, as the harness asked it. */
export const QuestionSchema = z.strictObject({
  format: z.literal(1),
  toolUseId: z.string().min(1),
  header: z.string().optional(),
  text: z.string(),
  options: z.array(z.strictObject({ label: z.string().min(1), description: z.string().optional() })),
  multiple: z.boolean().default(false),
  askedAt: InstantSchema,
});
export type Question = z.infer<typeof QuestionSchema>;

/** One entry of `answers.jsonl`: what the owner answered, kept so an answered question does not come back. */
export const AnswerRecordSchema = z.strictObject({
  v: z.literal(1),
  toolUseId: z.string().min(1),
  answers: z.array(StructuredQuestionAnswerSchema),
  answeredAt: InstantSchema,
});
export type AnswerRecord = z.infer<typeof AnswerRecordSchema>;
