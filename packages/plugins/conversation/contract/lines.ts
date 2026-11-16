/**
 * The LINES of the three JSONL files Conversation keeps under `state/conversation/<ferret>/` (§9.2): the answers, the
 * inbox and the outbox. The other two — `queue.jsonl` and `sends.jsonl` — are the Mailbox's lines
 * (`@ferretry/core-mailbox/contract`); they are DECLARED here (`state.ts`) and stay where they are on disk.
 */
import { SendDispositionSchema } from '@ferretry/core-mailbox/contract';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

const NonNegativeInteger = z.number().int().nonnegative();

// answers.jsonl ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One line of `answers.jsonl`: the receipt of one answer operation, written BEFORE any key is driven; the last line per
 * `requestId` wins. It holds the fingerprint of the answer, never its words. A resolution (`failed`, `quarantined`,
 * `acknowledged`) is written as the same `accepted` receipt with how it resolved, so the file never records two
 * different promises about one request.
 */
export const AnswerLineSchema = z.strictObject({
  /** The caller's idempotency key; the ferret comes from where the file is stored. */
  requestId: z.string().min(1),
  /** The rendered form this operation bound to. */
  toolUseId: z.string().min(1),
  /** The canonical rendering of the answer this id names; a second payload under one id is refused. */
  fingerprint: z.string().min(1),
  acceptedAt: InstantSchema,
  outcome: z.enum(['accepted', 'confirmed', 'withdrawn']),
  resolution: z.enum(['failed', 'quarantined', 'acknowledged']).optional(),
  /** Why a `withdrawn` record is safe to retry, or why an `accepted` one needs a person. */
  reason: z.string().optional(),
  at: InstantSchema,
});
export type AnswerLine = z.infer<typeof AnswerLineSchema>;

// inbox.jsonl, outbox.jsonl ─────────────────────────────────────────────────────────────────────────────────────────

/** One line of `inbox.jsonl`: what reached a ferret (the receiver's copy, with whatever the transport added). */
export const InboxLineSchema = z.strictObject({
  at: InstantSchema,
  type: z.literal('message'),
  message: z.string(),
  turn: NonNegativeInteger.optional(),
  queued: z.boolean().optional(),
  queueId: z.string().min(1).optional(),
  queuedForRevive: z.boolean().optional(),
  reason: z.string().optional(),
  from: z.string().optional(),
  fromName: z.string().optional(),
});
export type InboxLine = z.infer<typeof InboxLineSchema>;

/** One line of `outbox.jsonl`: what a ferret sent, the logical message before any transport decoration. */
export const OutboxLineSchema = z.strictObject({
  at: InstantSchema,
  type: z.literal('message'),
  from: z.string().min(1),
  fromName: z.string().optional(),
  to: z.string().min(1),
  disposition: SendDispositionSchema,
  message: z.string(),
});
export type OutboxLine = z.infer<typeof OutboxLineSchema>;
