/**
 * The LINES of the five JSONL files under `state/conversation/<ferret>/` (§9.2), as the stores write them. A line is not
 * the wire view of the thing it records: the view of a queued message, a send or an answer is what a route returns
 * (`QueuedMessageSchema`, `SendRecordSchema`, `AnswerRecordSchema`), and each is a fold or a projection of these lines.
 * Exported so anything that reads a file by hand (a tool, a test, a later reader) parses it with the schema the writer
 * is tested against.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import {
  QueuedMessageIdSchema,
  QueuedMessageSchema,
  QueuedMessageStateSchema,
  QueueAuthorSchema,
  QueueWaitReasonSchema,
  SendCancelEffectSchema,
  SendDispositionSchema,
  SendEvidenceSchema,
  SendPathSchema,
  SenderKindSchema,
  SendUnaccountedReasonSchema,
} from './wire-send.ts';

const NonNegativeInteger = z.number().int().nonnegative();
const PositiveInteger = z.number().int().positive();

// queue.jsonl ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One line of `queue.jsonl`: the queue as a LOG OF WHAT HAPPENED. Every line names the message it moves, and the fold
 * (`foldQueue`) applies only what is legal from where that message stands, so a line replayed twice or out of order
 * changes nothing it should not.
 */
export const QueueEventSchema = z.discriminatedUnion('kind', [
  /** A message was accepted into the queue, whole, exactly as it was first sent. */
  z.object({ v: z.literal(1), kind: z.literal('enqueued'), at: InstantSchema, message: QueuedMessageSchema }),
  /** Its text was replaced while it was still waiting; `revision` is the one it becomes. */
  z.object({
    v: z.literal(1),
    kind: z.literal('edited'),
    at: InstantSchema,
    id: QueuedMessageIdSchema,
    text: z.string(),
    revision: z.number().int().min(2),
  }),
  /** It moved to `state`. */
  z.object({
    v: z.literal(1),
    kind: z.literal('moved'),
    at: InstantSchema,
    id: QueuedMessageIdSchema,
    state: QueuedMessageStateSchema,
    failure: z.string().optional(),
    /**
     * Beside a move to `typing`: this message goes out inside the combined turn sent under that id (the oldest member's
     * own id, so the lead carries its own). Absent: it is sent alone, under its own id.
     */
    batch: z.string().min(1).optional(),
  }),
  /** Why it is still waiting changed; no `reason` means nothing but its turn is in its way. */
  z.object({
    v: z.literal(1),
    kind: z.literal('waiting'),
    at: InstantSchema,
    id: QueuedMessageIdSchema,
    reason: QueueWaitReasonSchema.optional(),
    /** The send of this ferret's own whose unsubmitted text holds the box (B144); only beside `draft`. */
    behind: z.string().min(1).optional(),
  }),
]);
export type QueueEvent = z.infer<typeof QueueEventSchema>;

// sends.jsonl ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A fate as the ledger writes it: the wire's, and `withdrawn` (nothing was ever typed; the id may start over). */
export const SendLineFateSchema = z.enum([
  'accepted',
  'queued',
  'delivered',
  'unaccounted',
  'timed_out',
  'withdrawn',
  'cancelled',
]);

/**
 * One line of `sends.jsonl`: the daemon's own record of a send, appended whole at every change (accept, revise, settle,
 * withdraw), the last line for a `sendId` winning. Unlike the wire view it has no `v`, carries the daemon's bookkeeping
 * (`submitNudges`, `busyTyped`, `untyped`, `noticesOwed`, `evidenceNotBefore`, `matchText`, `payloadFile`: none of it leaves the daemon), and
 * adds `at`, when this line was written, and `reason`, only on a withdrawal.
 */
export const SendLineSchema = z.strictObject({
  sendId: z.string().min(1),
  acceptedAt: InstantSchema,
  acceptedTurn: NonNegativeInteger,
  path: SendPathSchema,
  message: z.string(),
  matchText: z.string().optional(),
  turn: NonNegativeInteger.optional(),
  attachmentIds: z.array(z.string()).optional(),
  from: z.string().optional(),
  fromName: z.string().optional(),
  senderKind: SenderKindSchema.optional(),
  /** The messages one combined turn carries, oldest first; only on the one row such a delivery is ledgered under. */
  batch: z.array(z.strictObject({ queueId: z.string().min(1), from: z.string().min(1) })).optional(),
  by: QueueAuthorSchema.optional(),
  replyExpected: z.boolean().optional(),
  payloadFile: z.string().optional(),
  held: z.boolean().optional(),
  fate: SendLineFateSchema,
  fateAt: InstantSchema.optional(),
  evidence: SendEvidenceSchema.optional(),
  unaccountedReason: SendUnaccountedReasonSchema.optional(),
  queuedAt: InstantSchema.optional(),
  queueProof: z.enum(['transcript', 'pane']).optional(),
  attempt: PositiveInteger.optional(),
  attemptAt: InstantSchema.optional(),
  /** A person's Retry of an update-unconfirmed send: no transcript input before this instant is proof of delivery. */
  evidenceNotBefore: InstantSchema.optional(),
  deadlineAt: InstantSchema.optional(),
  retryable: z.boolean().optional(),
  typedNotSent: z.boolean().optional(),
  submitNudges: NonNegativeInteger.optional(),
  busyTyped: z.boolean().optional(),
  untyped: z.boolean().optional(),
  cancelEffect: SendCancelEffectSchema.optional(),
  /** The failure notices a final fate still owes its senders, shortened one member at a time as each is sent. */
  noticesOwed: z.array(z.strictObject({ from: z.string().min(1), sendId: z.string().min(1) })).optional(),
  at: InstantSchema,
  reason: z.string().optional(),
});
export type SendLine = z.infer<typeof SendLineSchema>;

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
