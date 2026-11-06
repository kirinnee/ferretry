import { z } from 'zod';
import { InstantSchema, PositiveIntegerSchema } from './common.ts';
import { PeerMessageLabelSchema, QueueAuthorSchema, SendSenderKindSchema } from './session.ts';
import { QueueWaitReasonSchema } from './session-queue-wait.ts';

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
  /** A ferret's own label for the message (`fy send --kind`); absent is `action`. Never set on a person's or the daemon's. */
  label: PeerMessageLabelSchema.optional(),
  /**
   * The instant the queue stops holding this ferret's message to combine it with others: `enqueuedAt` plus
   * the action window or the FYI cap, fixed when it was accepted so a settings change never moves a hold.
   * Absent: never held.
   */
  holdUntil: InstantSchema.optional(),
  /**
   * Set on every message delivered inside one combined turn: the id of the message the turn was sent under
   * (the oldest). The send ledger has one record, under that id; this is how the others find it.
   */
  deliveredAs: z.string().min(1).optional(),
  enqueuedAt: InstantSchema,
  state: QueuedMessageStateSchema,
  /** When it reached `state`. */
  stateAt: InstantSchema,
  /** 1 as sent; each edit while still `queued` adds one. */
  revision: PositiveIntegerSchema,
  waitReason: QueueWaitReasonSchema.optional(),
  /**
   * Beside a `draft` wait: the send of this session's own whose text sits typed and unsubmitted in the
   * box — Ferretry's, not a person's. The daemon has pressed Enter on it (bounded) and it did not take.
   */
  waitBehind: z.string().min(1).optional(),
  /** Why a `failed` message failed, in a sentence. */
  failure: z.string().optional(),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

/** `PATCH /v1/sessions/:sessionId/queue/:messageId`: new words for a message that is still waiting. */
export const QueueEditRequestSchema = z.strictObject({ text: z.string().trim().min(1) });
export type QueueEditRequest = z.infer<typeof QueueEditRequestSchema>;

/**
 * `GET /v1/sessions/:sessionId/queue`: a window onto the session's queue, oldest first. With no parameters it is
 * the newest page and every message that can still move (`queued`, `typing`, `unconfirmed`), the same window
 * `GET …/sends` answers; `?before=<nextCursor>` (and `limit`) pages the older history, each message once.
 *
 * `nextCursor` is OPAQUE — hand it back as `before` untouched. It names the oldest message of the page proper (and the
 * snapshot the walk was cut at, so a message that changes state mid-walk is still met once), or is `null` when nothing
 * older is left. It is absent from an answer of a daemon from before the window, which held the whole queue: absent
 * reads as `null`.
 * A reader written before the window ignores it and sees the same `messages` array, only shorter.
 */
export const SessionQueueSchema = z.object({
  messages: z.array(QueuedMessageSchema),
  nextCursor: z.string().min(1).nullable().optional(),
});
export type SessionQueue = z.infer<typeof SessionQueueSchema>;

/**
 * The session journal event a durable queue change publishes AFTER the change is on disk, so an open chat
 * (and any other reader of `/v1/events`) learns it must read `GET …/queue` again. It carries ids and a kind
 * only — never message text — and changes nothing a session LIST row shows, so the fleet feed does not re-read
 * the list for it. A reader that does not know it ignores it safely: the event schema's `type` is free-form.
 */
export const QUEUE_CHANGED_EVENT = 'control.queue_changed';

/** What a {@link QUEUE_CHANGED_EVENT} says: which message, and which kind of change. */
export interface QueueChangedEventData {
  readonly messageId: string;
  readonly change: 'enqueued' | 'edited' | 'moved' | 'waiting';
}
