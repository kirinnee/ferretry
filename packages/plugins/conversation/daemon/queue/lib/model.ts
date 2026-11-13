import { type QueueEvent, QueueEventSchema } from '../../../contract/index.ts';
import type { QueuedMessage, QueuedMessageState } from '../../seams/protocol.ts';

/**
 * A session's queue as a LOG OF WHAT HAPPENED, folded into the messages it holds.
 *
 * Append-only for the reason the send ledger is: the queue is written before a key is typed, so it must
 * survive a daemon that dies mid-keystroke, and a log that is only ever appended to cannot be corrupted by
 * one. Every event names the message it moves, and the fold applies only what is LEGAL from where that
 * message stands — so a line replayed twice, written out of order, or left by an older daemon changes
 * nothing it should not. The fold is total: whatever the file holds, it answers a queue.
 */

/** One line of a session's queue file: the contract's `QueueEventSchema`, the one definition of what the store writes. */
export { type QueueEvent, QueueEventSchema };

/**
 * Where a message may go next. A key is typed only in `typing`; a typing the pane refused before any key
 * goes back to `queued`, and nothing else ever moves backwards. `read`, `cancelled` and `failed` are final.
 */
const NEXT: Readonly<Record<QueuedMessageState, ReadonlySet<QueuedMessageState>>> = {
  queued: new Set(['typing', 'cancelled', 'failed']),
  typing: new Set(['queued', 'delivered', 'unconfirmed', 'failed']),
  delivered: new Set(['read']),
  unconfirmed: new Set(['delivered', 'read']),
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
      const { waitReason: _reason, waitBehind: _behind, failure: _failure, deliveredAs: _batch, ...rest } = message;
      // `deliveredAs` is set as it starts typing and kept through delivered and read; a typing the pane
      // refused goes back to `queued` unbatched, since nothing was sent under that id.
      const deliveredAs = event.state === 'typing' ? event.batch : event.state === 'queued' ? undefined : _batch;
      return {
        ...rest,
        ...(deliveredAs === undefined ? {} : { deliveredAs }),
        state: event.state,
        stateAt: event.at,
        // Any move ends the wait it had (a typing the pane refuses says why again), and only a failed
        // message says why it failed.
        ...(event.state === 'failed' && event.failure !== undefined ? { failure: event.failure } : {}),
      };
    }
    case 'waiting': {
      if (message.state !== 'queued') return message;
      const { waitReason: _reason, waitBehind: _behind, ...rest } = message;
      if (event.reason === undefined) return rest;
      return { ...rest, waitReason: event.reason, ...(event.behind === undefined ? {} : { waitBehind: event.behind }) };
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
  // `version` is the 1-based position in the log of the latest line that CHANGED the message: the log is append-only,
  // so it only grows, and unlike a clock it is never shared by two changes.
  let position = 0;
  for (const event of events) {
    position += 1;
    if (event.kind === 'enqueued') {
      if (!messages.has(event.message.id)) messages.set(event.message.id, { ...event.message, version: position });
      continue;
    }
    const current = messages.get(event.id);
    if (current === undefined) continue;
    const next = applied(current, event);
    messages.set(event.id, next === current ? current : { ...next, version: position });
  }
  return [...messages.values()];
}
