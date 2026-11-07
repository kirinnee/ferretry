/** A question a ferret asks mid-turn, and its answer (today's `session.ts` answer schemas). */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

export const StructuredQuestionAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('selection'), labels: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ kind: z.literal('other'), text: z.string().trim().min(1) }),
]);
export type StructuredQuestionAnswer = z.infer<typeof StructuredQuestionAnswerSchema>;

/** `POST /v1/ferrets/:ferretId/answer` body. Owner-only (`caller: 'person'`): a ferret never answers itself. */
export const AnswerRequestSchema = z.strictObject({
  toolUseId: z.string().min(1),
  labels: z.array(z.string().min(1)),
  other: z.string().optional(),
  responses: z.array(z.string()).optional(),
  answers: z.array(StructuredQuestionAnswerSchema).min(1).optional(),
});
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

/**
 * `state/conversation/<ferret>/question.json`: the question the ferret is waiting on, as the harness asked it. Stored
 * PARSED, never as the hook's raw payload: Conversation's writer reads the `PreToolUse` payload, proves it against the
 * ferret's transcript, and keeps only this.
 */
export const QuestionSchema = z.strictObject({
  format: z.literal(1),
  toolUseId: z.string().min(1),
  header: z.string().optional(),
  text: z.string(),
  options: z.array(z.strictObject({ label: z.string().min(1), description: z.string().optional() })),
  multiple: z.boolean().default(false),
  askedAt: InstantSchema,
  /**
   * The transcript the asking hook named, which the question was proved against when it was written: a reader holding
   * another transcript (a later conversation, a subagent's file) does not take it as this ferret's question. Kept in
   * the file only; the question route and port answer without it.
   */
  transcript: z.string().min(1).optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

/**
 * What the owner answered to ONE question, as a view of the answer. It is NOT a line of `answers.jsonl`: that file holds
 * the answer ledger's receipts, one per request, written before any key is driven (`AnswerLineSchema`). A receipt
 * carries the request id, the question's tool-use id, the fingerprint of the answer and how far the operation got, and
 * never the answer's words.
 */
export const AnswerRecordSchema = z.strictObject({
  v: z.literal(1),
  toolUseId: z.string().min(1),
  answers: z.array(StructuredQuestionAnswerSchema),
  answeredAt: InstantSchema,
});
export type AnswerRecord = z.infer<typeof AnswerRecordSchema>;

/** `GET /v1/ferrets/:ferretId/question`: the question the ferret is waiting on, or none (today's ferret view carried it as `pendingQuestion`). */
export const AskedQuestionViewSchema = z.strictObject({ question: QuestionSchema.nullable() });
export type AskedQuestionView = z.infer<typeof AskedQuestionViewSchema>;
