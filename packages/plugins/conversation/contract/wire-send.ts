/** Sending, the queue and the send ledger (today's `session.ts`, `session-queue.ts`, `session-queue-wait.ts`). */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';

const NonNegativeInteger = z.number().int().nonnegative();
const PositiveInteger = z.number().int().positive();

/** How soon a ferret's message is delivered: `blocker` at once, `action` combined, `fyi` held (`fy send --kind`). */
export const MESSAGE_LABELS = ['blocker', 'action', 'fyi'] as const;
export const MessageLabelSchema = z.enum(MESSAGE_LABELS);
export type MessageLabel = z.infer<typeof MessageLabelSchema>;

export const SendFateSchema = z.enum(['accepted', 'queued', 'delivered', 'unaccounted', 'timed_out', 'cancelled']);
export type SendFate = z.infer<typeof SendFateSchema>;

export const SendPathSchema = z.enum(['direct', 'turn-file', 'native-inline', 'native-file', 'revive', 'revive-queue']);
export type SendPath = z.infer<typeof SendPathSchema>;

export const SendUnaccountedReasonSchema = z.enum([
  'timeout',
  'ferret_ended',
  'composer_discarded',
  'transcript_unreadable',
  'transcript_unbound',
  'pane_unreadable',
  'blocked_by_prompt',
  'revive_unconfirmed',
  'landing_unconfirmed',
  'typed_not_submitted',
  'not_delivered',
]);
export type SendUnaccountedReason = z.infer<typeof SendUnaccountedReasonSchema>;

export const SenderKindSchema = z.enum(['human', 'agent', 'daemon']);
export type SenderKind = z.infer<typeof SenderKindSchema>;

export const QueueAuthorSchema = z.strictObject({
  kind: z.enum(['owner', 'ferret', 'ferretry']),
  name: z.string().min(1).optional(),
  feature: z.string().min(1).optional(),
  sections: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
});
export type QueueAuthor = z.infer<typeof QueueAuthorSchema>;

/** Why a message still waits in Ferretry's queue. */
export const QueueWaitReasonSchema = z.enum([
  'launching',
  'busy',
  'question',
  'dialog',
  'draft',
  'unreadable',
  'stopped',
]);
export type QueueWaitReason = z.infer<typeof QueueWaitReasonSchema>;

export const SendEvidenceSchema = z.strictObject({
  key: z.string().min(1),
  harness: z.string().min(1),
  kind: z.enum(['chat.user', 'queued_command', 'response_item']),
  proof: z.enum(['normal-user-record', 'native-queue-drain']),
  observedAt: InstantSchema,
  originatedAt: InstantSchema.optional(),
  shapeVersion: PositiveInteger,
  matchedTurn: NonNegativeInteger,
  tier: z.enum(['queue-file-id', 'turn-instruction', 'exact-text', 'merged-text']),
});
export type SendEvidence = z.infer<typeof SendEvidenceSchema>;

export const SendCancelEffectSchema = z.enum(['cleared', 'not_in_pane', 'left_in_queue', 'left_in_composer']);

/**
 * One send as the wire shows it (`GET .../sends`): the ledger of a message from acceptance to its fate. It is the VIEW,
 * not a line of `sends.jsonl`: the store writes the daemon's own record (`SendLineSchema`: no `v`, a wider `fate` with
 * `withdrawn`, the daemon's bookkeeping, and the instant and reason of each write), and this is what that record is
 * shown as. Last write per `sendId` wins.
 */
export const SendRecordSchema = z.strictObject({
  v: z.literal(1),
  sendId: z.string().min(1),
  acceptedAt: InstantSchema,
  acceptedTurn: NonNegativeInteger,
  path: SendPathSchema,
  message: z.string(),
  turn: NonNegativeInteger.optional(),
  attachmentIds: z.array(z.string()),
  from: z.string().optional(),
  fromName: z.string().optional(),
  senderKind: SenderKindSchema.optional(),
  by: QueueAuthorSchema.optional(),
  replyExpected: z.boolean().optional(),
  held: z.boolean().optional(),
  withdrawn: z.boolean().optional(),
  fate: SendFateSchema,
  fateAt: InstantSchema.optional(),
  evidence: SendEvidenceSchema.optional(),
  unaccountedReason: SendUnaccountedReasonSchema.optional(),
  queuedAt: InstantSchema.optional(),
  queueProof: z.enum(['transcript', 'pane']).optional(),
  attempt: PositiveInteger.optional(),
  attemptAt: InstantSchema.optional(),
  deadlineAt: InstantSchema.optional(),
  retryable: z.boolean().optional(),
  typedNotSent: z.boolean().optional(),
  cancelEffect: SendCancelEffectSchema.optional(),
  opportunityAt: InstantSchema.optional(),
  unaccountedDeadline: InstantSchema.optional(),
  hardDeadline: InstantSchema.optional(),
  timeoutFrozenAt: InstantSchema.optional(),
});
export type SendRecord = z.infer<typeof SendRecordSchema>;

export const SendListResponseSchema = z.strictObject({
  sends: z.array(SendRecordSchema),
  nextCursor: z.string().nullable().optional(),
});
export type SendListResponse = z.infer<typeof SendListResponseSchema>;

export const SendRetryRequestSchema = z.strictObject({ force: z.boolean().optional() });
export const SendCancelRequestSchema = z.strictObject({});
export const SendEnterRequestSchema = z.strictObject({});

/** `POST /v1/ferrets/:ferretId/send` body (today's `SendRequestSchema`; `sharedDraft` is `SharedDraftSentSchema`). */
export const SendRequestSchema = z.strictObject({
  message: z.string().min(1),
  /**
   * The caller's idempotency key for this one send (today's `X-Fy-Request-Id`): the same key twice is ONE message, on the
   * same ferret, across daemon runs. It is the message's own id in the queue and in the send ledger, so both stores keep
   * it and a repeat finds the first request's message instead of making a second. Absent, the daemon mints one.
   */
  sendId: z.string().min(1).max(128).optional(),
  attachmentIds: z.array(z.string()).optional(),
  now: z.boolean().optional(),
  replyExpected: z.boolean().optional(),
  label: MessageLabelSchema.optional(),
  sharedDraft: z.unknown().optional(),
});
export type SendRequest = z.infer<typeof SendRequestSchema>;

export const SendDispositionSchema = z.enum(['delivered', 'queued', 'sent', 'revived', 'queued-for-revive']);

/**
 * The answer to a send. Today's result extends the whole session view; here it names the ferret and carries the
 * send's own fields, because the view belongs to Ferrets (the port adds `view` when the Ferrets contract lands).
 */
export const SendResultSchema = z.strictObject({
  ferret: FerretIdSchema,
  disposition: SendDispositionSchema,
  sendId: z.string().min(1).optional(),
  fate: SendFateSchema.optional(),
  waitReason: QueueWaitReasonSchema.optional(),
  waitBehind: z.string().min(1).optional(),
  label: MessageLabelSchema.optional(),
  heldUntil: InstantSchema.optional(),
});
export type SendResult = z.infer<typeof SendResultSchema>;

export const QueuedMessageStateSchema = z.enum([
  'queued',
  'typing',
  'delivered',
  'read',
  'unconfirmed',
  'cancelled',
  'failed',
]);
export type QueuedMessageState = z.infer<typeof QueuedMessageStateSchema>;

export const QueuedMessageIdSchema = z.string().min(1).max(128);

/**
 * One queued message, as the FOLD of `queue.jsonl` describes it (the wire view). A line of that file is not this: it is
 * one event that moves a message (`QueueEventSchema`), and the first of them (`enqueued`) carries this whole.
 */
export const QueuedMessageSchema = z.strictObject({
  v: z.literal(1),
  id: QueuedMessageIdSchema,
  sender: SenderKindSchema,
  from: z.string().optional(),
  fromName: z.string().optional(),
  by: QueueAuthorSchema.optional(),
  text: z.string(),
  attachmentIds: z.array(z.string()),
  replyExpected: z.boolean().optional(),
  interrupt: z.boolean().optional(),
  label: MessageLabelSchema.optional(),
  holdUntil: InstantSchema.optional(),
  deliveredAs: z.string().min(1).optional(),
  enqueuedAt: InstantSchema,
  state: QueuedMessageStateSchema,
  stateAt: InstantSchema,
  revision: PositiveInteger,
  waitReason: QueueWaitReasonSchema.optional(),
  waitBehind: z.string().min(1).optional(),
  failure: z.string().optional(),
  version: PositiveInteger.optional(),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

export const QueueEditRequestSchema = z.strictObject({ text: z.string().trim().min(1) });
export type QueueEditRequest = z.infer<typeof QueueEditRequestSchema>;

export const FerretQueueSchema = z.strictObject({
  messages: z.array(QueuedMessageSchema),
  nextCursor: z.string().min(1).nullable().optional(),
});
export type FerretQueue = z.infer<typeof FerretQueueSchema>;

export const InterruptRequestSchema = z.strictObject({ toolUseId: z.string().min(1).optional() });
export type InterruptRequest = z.infer<typeof InterruptRequestSchema>;

export const COMPOSER_DRAFT_MAX_CHARS = 20_000;
export const ComposerRequestSchema = z.strictObject({
  action: z.enum(['submit', 'clear']),
  draft: z.string().min(1).max(COMPOSER_DRAFT_MAX_CHARS),
});
export const ComposerOutcomeSchema = z.enum(['submitted', 'holding', 'cleared', 'absent', 'changed', 'stuck']);
export const ComposerResultSchema = z.strictObject({
  action: z.enum(['submit', 'clear']),
  outcome: ComposerOutcomeSchema,
});
export type ComposerResult = z.infer<typeof ComposerResultSchema>;

/** `PATCH /v1/ferrets/:ferretId/hypermedia`: whether the ferret may emit renders (today's route; body is a switch). */
export const HypermediaRequestSchema = z.strictObject({ enabled: z.boolean() });
export type HypermediaRequest = z.infer<typeof HypermediaRequestSchema>;

/** What switching it did: nothing is sent to the ferret, so a RUNNING one takes the change at its next launch. */
export const HypermediaResultSchema = z.strictObject({
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type HypermediaResult = z.infer<typeof HypermediaResultSchema>;

/** The queue-changed wake-up's data (today's `QUEUE_CHANGED_EVENT`, `control.queue_changed`). */
export const QueueChangeSchema = z.enum(['enqueued', 'edited', 'moved', 'waiting']);
