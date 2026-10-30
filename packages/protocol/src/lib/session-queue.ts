import { z } from 'zod';
import { InstantSchema, PositiveIntegerSchema } from './common.ts';
import { SendSenderKindSchema } from './session.ts';

/**
 * ONE DURABLE QUEUE PER SESSION: every message to a ferret — the owner's, another ferret's, the daemon's —
 * is written here before anything is typed, and leaves it only by being delivered, read, cancelled or
 * failed. It replaces the patchwork that lost the owner's message on 2026-10-30: a send withdrawn a second
 * after it was accepted, a payload file left behind, and Warden notices typed ahead of it.
 *
 * The ticks a person sees are the states, in order: ✓ `queued` (written, on accept), ✓✓ `delivered` (typed
 * and submitted into the agent, proven by its pane), ✓✓✓ `read` (its transcript shows it as a user turn).
 */

/**
 * Where one message is. `typing` is the one moment a key is going to the pane; at most one is, per session.
 * `unconfirmed` was typed and nothing proves it reached the agent, though it may have: never shown as a
 * failure, and moved on to delivered or read if proof turns up later.
 */
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

/**
 * Why a `queued` message has not gone yet, in words a person can act on. Absent when nothing is in its way
 * but its turn: another message ahead of it.
 */
export const QueueWaitReasonSchema = z.enum([
  /** The agent is still starting. */
  'launching',
  /** The agent is mid-turn and its own queue cannot take the message yet. */
  'busy',
  /** The agent asked a question, and only its answer may go into the pane. */
  'question',
  /** A harness dialog (trust, permission, rate limit) holds the pane. */
  'dialog',
  /** The composer holds text that is not this message: a person's draft, most often. */
  'draft',
  /** The pane could not be read well enough to prove the composer empty. */
  'unreadable',
  /** The session is not running; it is delivered when it is revived. */
  'stopped',
]);
export type QueueWaitReason = z.infer<typeof QueueWaitReasonSchema>;

/**
 * WHO A MESSAGE IS FROM, AS DATA. The owner (2026-10-30): "there should not be any append or prepend on any
 * feature". Who sent a message and which feature it came from are never text in its body: the app reads
 * them from here and shows a sender chip — "Ferretry · Board", a ferret's name, nothing for the owner.
 */
export const QueueAuthorSchema = z.strictObject({
  kind: z.enum(['owner', 'ferret', 'ferretry']),
  /** A ferret's name (its callsign), for a ferret's message. */
  name: z.string().min(1).optional(),
  /** The part of Ferretry that sent it: Board, Warden, Agenda, Monitor, Lessons. */
  feature: z.string().min(1).optional(),
});
export type QueueAuthor = z.infer<typeof QueueAuthorSchema>;

/** The caller's own id for a message, the idempotency key a retried request is answered from. */
export const QueuedMessageIdSchema = z.string().min(1).max(128);

/** One message in a session's queue, as the wire carries it. */
export const QueuedMessageSchema = z.object({
  v: z.literal(1),
  id: QueuedMessageIdSchema,
  /** Who sent it, which decides its place: a person's first, then a ferret's, then the daemon's. */
  sender: SendSenderKindSchema,
  /** The sending ferret's session, for a ferret's message. */
  from: z.string().optional(),
  fromName: z.string().optional(),
  /** Who it is from, for the app's sender chip. Absent on a message queued before it existed. */
  by: QueueAuthorSchema.optional(),
  text: z.string(),
  attachmentIds: z.array(z.string()),
  /** The sender is parked awaiting the reply, so the agent is told how to unblock them. */
  replyExpected: z.boolean().optional(),
  /**
   * Stop the agent's running turn first. Not a separate path: the message keeps its place in the queue,
   * and when its turn comes AND the input box is empty the deliverer stops the turn, then types and
   * submits it, in one step (`fy send --now`).
   */
  interrupt: z.boolean().optional(),
  enqueuedAt: InstantSchema,
  state: QueuedMessageStateSchema,
  /** When it reached `state`. */
  stateAt: InstantSchema,
  /** 1 as sent; each edit while still `queued` adds one. */
  revision: PositiveIntegerSchema,
  waitReason: QueueWaitReasonSchema.optional(),
  /** Why a `failed` message failed, in a sentence. */
  failure: z.string().optional(),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

/** `PATCH /v1/sessions/:sessionId/queue/:messageId`: new words for a message that is still waiting. */
export const QueueEditRequestSchema = z.strictObject({ text: z.string().trim().min(1) });
export type QueueEditRequest = z.infer<typeof QueueEditRequestSchema>;

/** `GET /v1/sessions/:sessionId/queue`: every message the session's queue holds, oldest first. */
export const SessionQueueSchema = z.object({ messages: z.array(QueuedMessageSchema) });
export type SessionQueue = z.infer<typeof SessionQueueSchema>;
