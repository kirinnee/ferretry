import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

export const ATTENTION_SCHEMA_VERSION = 1 as const;
export const MAX_ATTENTION_PER_SESSION = 20;
export const MAX_ATTENTION_RESOLUTIONS = 100;
export const MAX_ATTENTION_SUBJECT_LENGTH = 240;
export const MAX_ATTENTION_DETAIL_LENGTH = 2_048;
export const MAX_ATTENTION_SOURCE_REF_LENGTH = 512;
export const MAX_ATTENTION_ASK_OPTIONS = 12;
export const MAX_ATTENTION_ASK_OPTION_LENGTH = 120;
export const MAX_ATTENTION_ASK_OPTION_DETAIL_LENGTH = 240;
export const MAX_NOTIFICATION_TITLE_LENGTH = 120;
export const MAX_NOTIFICATION_BODY_LENGTH = 500;

const singleLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\r\n]*$/u, 'must be a single line');

export const AttentionSourceSchema = z.enum(['task', 'question', 'agent-raised']);
export type AttentionSource = z.infer<typeof AttentionSourceSchema>;

export const AttentionAskOptionSchema = z.strictObject({
  label: singleLine(MAX_ATTENTION_ASK_OPTION_LENGTH),
  description: singleLine(MAX_ATTENTION_ASK_OPTION_DETAIL_LENGTH).optional(),
});
export type AttentionAskOption = z.infer<typeof AttentionAskOptionSchema>;

const MultipleChoiceAskSchema = z
  .strictObject({
    kind: z.literal('multiple-choice'),
    options: z.array(AttentionAskOptionSchema).min(2).max(MAX_ATTENTION_ASK_OPTIONS),
  })
  .superRefine((value, context) => {
    const labels = value.options.map(option => option.label.trim());
    if (new Set(labels).size !== labels.length) {
      context.addIssue({ code: 'custom', message: 'option labels must be unique', path: ['options'] });
    }
  });

export const AttentionAskSchema = z.union([
  z.strictObject({ kind: z.literal('permission') }),
  MultipleChoiceAskSchema,
  z.strictObject({ kind: z.literal('answer-review') }),
  z.strictObject({ kind: z.literal('open-question') }),
]);
export type AttentionAsk = z.infer<typeof AttentionAskSchema>;

const AnswerReviewResponseSchema = z.discriminatedUnion('verdict', [
  z.strictObject({ kind: z.literal('answer-review'), verdict: z.literal('good') }),
  z.strictObject({
    kind: z.literal('answer-review'),
    verdict: z.literal('clarify'),
    clarification: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  }),
]);

export const AttentionResponseSchema = z.union([
  z.strictObject({ kind: z.literal('permission'), decision: z.enum(['approve', 'reject']) }),
  z.strictObject({
    kind: z.literal('multiple-choice'),
    choice: singleLine(MAX_ATTENTION_ASK_OPTION_LENGTH),
  }),
  AnswerReviewResponseSchema,
  z.strictObject({
    kind: z.literal('open-question'),
    answer: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  }),
]);
export type AttentionResponse = z.infer<typeof AttentionResponseSchema>;

export const AttentionDispositionSchema = z.enum(['done', 'dismissed']);
export type AttentionDisposition = z.infer<typeof AttentionDispositionSchema>;

export const AttentionIdSchema = z.string().regex(/^A[1-9][0-9]*$/u);
export type AttentionId = z.infer<typeof AttentionIdSchema>;

export const AttentionBySchema = z.enum(['human', 'agent', 'daemon']);
export type AttentionBy = z.infer<typeof AttentionBySchema>;

const AttentionItemBaseShape = {
  id: AttentionIdSchema,
  source: AttentionSourceSchema,
  sourceRef: z.string().max(MAX_ATTENTION_SOURCE_REF_LENGTH).nullable(),
  sourceSeq: PositiveIntegerSchema.optional(),
  subject: singleLine(MAX_ATTENTION_SUBJECT_LENGTH),
  why: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  context: z.string().max(MAX_ATTENTION_DETAIL_LENGTH).nullable().optional(),
  waitingSince: InstantSchema,
  howToResolve: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  ask: AttentionAskSchema.optional(),
};

export const AttentionItemSchema = z
  .discriminatedUnion('raisedBy', [
    z.object({
      ...AttentionItemBaseShape,
      raisedBy: z.literal('human'),
      raisedBySession: z.null(),
      raisedByName: z.null(),
    }),
    z.object({
      ...AttentionItemBaseShape,
      raisedBy: z.literal('agent'),
      raisedBySession: z.string().min(1),
      raisedByName: z.string().nullable(),
    }),
    z.object({
      ...AttentionItemBaseShape,
      raisedBy: z.literal('daemon'),
      raisedBySession: z.null(),
      raisedByName: z.null(),
    }),
  ])
  .superRefine((value, context) => {
    if (value.sourceSeq !== undefined && value.source !== 'agent-raised') {
      context.addIssue({ code: 'custom', message: 'sourceSeq is valid only for agent-raised attention' });
    }
  });
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

const ResolvedAttentionBaseShape = {
  resolvedAt: InstantSchema,
  resolutionNote: z.string().max(MAX_ATTENTION_DETAIL_LENGTH).nullable(),
  response: AttentionResponseSchema.optional(),
  disposition: AttentionDispositionSchema,
};

const AttentionResolutionSchema = z.discriminatedUnion('resolvedBy', [
  z.object({
    ...ResolvedAttentionBaseShape,
    resolvedBy: z.literal('human'),
    resolvedBySession: z.null(),
    resolvedByName: z.null(),
  }),
  z.object({
    ...ResolvedAttentionBaseShape,
    resolvedBy: z.literal('agent'),
    resolvedBySession: z.string().min(1),
    resolvedByName: z.string().nullable(),
  }),
  z.object({
    ...ResolvedAttentionBaseShape,
    resolvedBy: z.literal('daemon'),
    resolvedBySession: z.null(),
    resolvedByName: z.null(),
  }),
]);

export const ResolvedAttentionItemSchema = z
  .intersection(AttentionItemSchema, AttentionResolutionSchema)
  .superRefine((value, context) => {
    if (value.disposition === 'dismissed' && value.response !== undefined) {
      context.addIssue({ code: 'custom', message: 'a dismissed item may not carry a response', path: ['response'] });
    }
    if (value.response !== undefined && value.ask?.kind !== value.response.kind) {
      context.addIssue({ code: 'custom', message: 'response kind must match the original ask', path: ['response'] });
    }
    if (value.response?.kind === 'multiple-choice' && value.ask?.kind === 'multiple-choice') {
      const choices = value.ask.options.map(option => option.label.trim());
      if (!choices.includes(value.response.choice.trim())) {
        context.addIssue({
          code: 'custom',
          message: 'choice must name one of the ask options',
          path: ['response', 'choice'],
        });
      }
    }
  });
export type ResolvedAttentionItem = z.infer<typeof ResolvedAttentionItemSchema>;

export const AttentionSnapshotSchema = z
  .object({
    v: z.literal(ATTENTION_SCHEMA_VERSION),
    sessionId: z.string().min(1),
    items: z.array(AttentionItemSchema).max(MAX_ATTENTION_PER_SESSION),
    resolved: z.array(ResolvedAttentionItemSchema).max(MAX_ATTENTION_RESOLUTIONS),
    count: NonNegativeIntegerSchema,
    parseErrors: NonNegativeIntegerSchema,
    updatedAt: InstantSchema,
  })
  .superRefine((value, context) => {
    if (value.count !== value.items.length) {
      context.addIssue({ code: 'custom', message: 'count must equal the number of active items', path: ['count'] });
    }
    const activeIds = new Set(value.items.map(item => item.id));
    if (activeIds.size !== value.items.length) {
      context.addIssue({ code: 'custom', message: 'active attention ids must be unique', path: ['items'] });
    }
    const resolvedIds = value.resolved.map(item => item.id);
    if (new Set(resolvedIds).size !== resolvedIds.length) {
      context.addIssue({ code: 'custom', message: 'resolved attention ids must be unique', path: ['resolved'] });
    }
    if (resolvedIds.some(id => activeIds.has(id))) {
      context.addIssue({ code: 'custom', message: 'active and resolved attention ids must be disjoint' });
    }
  });
export type AttentionSnapshot = z.infer<typeof AttentionSnapshotSchema>;

const AddAttentionRequestSchema = z.strictObject({
  action: z.literal('add'),
  source: z.literal('agent-raised').default('agent-raised'),
  sourceRef: z.string().max(MAX_ATTENTION_SOURCE_REF_LENGTH).nullable().default(null),
  subject: singleLine(MAX_ATTENTION_SUBJECT_LENGTH),
  why: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  context: z.string().max(MAX_ATTENTION_DETAIL_LENGTH).nullable().optional(),
  howToResolve: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  ask: AttentionAskSchema.optional(),
});

export const AttentionActionRequestSchema = z.discriminatedUnion('action', [
  AddAttentionRequestSchema,
  z.strictObject({
    action: z.literal('resolve'),
    id: AttentionIdSchema,
    note: z.string().max(MAX_ATTENTION_DETAIL_LENGTH).optional(),
    response: AttentionResponseSchema.optional(),
  }),
  z.strictObject({
    action: z.literal('dismiss'),
    id: AttentionIdSchema,
    note: z.string().max(MAX_ATTENTION_DETAIL_LENGTH).optional(),
  }),
]);
export type AttentionActionRequest = z.infer<typeof AttentionActionRequestSchema>;

export const DirectNotificationRequestSchema = z.strictObject({
  body: z.string().trim().min(1).max(MAX_NOTIFICATION_BODY_LENGTH),
  title: singleLine(MAX_NOTIFICATION_TITLE_LENGTH).optional(),
  kind: z.enum(['completed', 'failed']).optional(),
});
export type DirectNotificationRequest = z.infer<typeof DirectNotificationRequestSchema>;

export const AttentionCountResponseSchema = z.object({
  sessionId: z.string().min(1),
  count: NonNegativeIntegerSchema,
});
export type AttentionCountResponse = z.infer<typeof AttentionCountResponseSchema>;

export const DirectNotificationResponseSchema = z.object({
  sessionId: z.string().min(1),
  delivered: NonNegativeIntegerSchema,
});
export type DirectNotificationResponse = z.infer<typeof DirectNotificationResponseSchema>;

export const AttentionErrorCodeSchema = z.enum([
  'invalid',
  'too-long',
  'not-found',
  'forbidden',
  'rate-limited',
  'read-only',
  'full',
  'corrupt',
]);
export type AttentionErrorCode = z.infer<typeof AttentionErrorCodeSchema>;
