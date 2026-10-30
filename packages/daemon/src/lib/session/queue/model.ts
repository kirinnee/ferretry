import {
  InstantSchema,
  QueuedMessageIdSchema,
  type QueuedMessage,
  QueuedMessageSchema,
  type QueuedMessageState,
  QueuedMessageStateSchema,
  QueueWaitReasonSchema,
} from '@ferretry/protocol';
import { z } from 'zod';

/**
 * A session's queue as a LOG OF WHAT HAPPENED, folded into the messages it holds.
 *
 * Append-only for the reason the send ledger is: the queue is written before a key is typed, so it must
 * survive a daemon that dies mid-keystroke, and a log that is only ever appended to cannot be corrupted by
 * one. Every event names the message it moves, and the fold applies only what is LEGAL from where that
 * message stands — so a line replayed twice, written out of order, or left by an older daemon changes
 * nothing it should not. The fold is total: whatever the file holds, it answers a queue.
 */

/** One line of a session's queue file. */
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
  }),
  /** Why it is still waiting changed; no `reason` means nothing but its turn is in its way. */
  z.object({
    v: z.literal(1),
    kind: z.literal('waiting'),
    at: InstantSchema,
    id: QueuedMessageIdSchema,
    reason: QueueWaitReasonSchema.optional(),
  }),
]);
export type QueueEvent = z.infer<typeof QueueEventSchema>;

/**
 * Where a message may go next. A key is typed only in `typing`; a typing the pane refused before any key
 * goes back to `queued`, and nothing else ever moves backwards. `read`, `cancelled` and `failed` are final.
 */
const NEXT: Readonly<Record<QueuedMessageState, ReadonlySet<QueuedMessageState>>> = {
  queued: new Set(['typing', 'cancelled', 'failed']),
  typing: new Set(['queued', 'delivered', 'failed']),
  delivered: new Set(['read']),
  read: new Set(),
  cancelled: new Set(),
  failed: new Set(),
};

/** Whether a message in `from` may move to `to`. */
export function canMove(from: QueuedMessageState, to: QueuedMessageState): boolean {
  return NEXT[from].has(to);
}

/** Whether a message has left the queue for good. */
export function isFinal(state: QueuedMessageState): boolean {
  return NEXT[state].size === 0;
}

/** One event applied to the message it names, or the message unchanged when the event is not legal. */
function applied(message: QueuedMessage, event: Exclude<QueueEvent, { kind: 'enqueued' }>): QueuedMessage {
  switch (event.kind) {
    case 'edited':
      return message.state === 'queued' && event.revision === message.revision + 1
        ? { ...message, text: event.text, revision: event.revision }
        : message;
    case 'moved': {
      if (!canMove(message.state, event.state)) return message;
      const { waitReason: _reason, failure: _failure, ...rest } = message;
      return {
        ...rest,
        state: event.state,
        stateAt: event.at,
        // Any move ends the wait it had (a typing the pane refuses says why again), and only a failed
        // message says why it failed.
        ...(event.state === 'failed' && event.failure !== undefined ? { failure: event.failure } : {}),
      };
    }
    case 'waiting': {
      if (message.state !== 'queued') return message;
      const { waitReason: _reason, ...rest } = message;
      return event.reason === undefined ? rest : { ...rest, waitReason: event.reason };
    }
  }
}

/**
 * The messages a log describes, in the order they were first accepted.
 *
 * An `enqueued` line for an id already held is a retried request and changes nothing; any other line for
 * an id never enqueued is ignored, since there is no message for it to move.
 */
export function foldQueue(events: readonly QueueEvent[]): readonly QueuedMessage[] {
  const messages = new Map<string, QueuedMessage>();
  for (const event of events) {
    if (event.kind === 'enqueued') {
      if (!messages.has(event.message.id)) messages.set(event.message.id, event.message);
      continue;
    }
    const current = messages.get(event.id);
    if (current !== undefined) messages.set(event.id, applied(current, event));
  }
  return [...messages.values()];
}
