import {
  type QueueEvent,
  QueueEventSchema,
  type QueueSegmentHeader,
  type SegmentMessage,
} from '../../../contract/index.ts';
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

/** A message whose `version` is known: every message a fold answers has one. */
export type VersionedMessage = QueuedMessage & { readonly version: number };

/** A message with the place it was first accepted: its index in the order every list of the queue keeps. */
export interface HeldMessage {
  readonly order: number;
  readonly message: VersionedMessage;
}

/**
 * A live SEGMENT's header, as the model sees it (`QueueSegmentHeaderSchema`). `UNROTATED_SEGMENT` is what a log with no
 * header is: it begins at position 0, has accepted nothing and carries nothing.
 */
export const UNROTATED_SEGMENT: QueueSegmentHeader = { v: 1, kind: 'segment', base: 0, accepted: 0, carried: 0 };

/**
 * One live segment of a queue, folded EVENT BY EVENT.
 *
 * `version` is the position of the latest event that CHANGED the message, counted over the whole queue: the segment
 * starts at `base`, so the event at line `i` is at `base + i` and a rotation never renumbers anything. The log is
 * append-only, so a position is never shared by two changes. `order` is when the message was first accepted, counted
 * the same way, so the messages come out "in the order first accepted" however many rotations ago the oldest was.
 *
 * It is a left fold that can be CONTINUED: `apply` takes one more event, so a store that appended a line does not fold
 * the segment again. `sealed` is the ids of messages already sealed into shards: an `enqueued` line for one is a retried
 * request, as it is for a message held here, and changes nothing.
 */
export class SegmentFold {
  private readonly held = new Map<string, HeldMessage>();
  private applied = 0;
  private accepted: number;

  constructor(
    readonly header: QueueSegmentHeader = UNROTATED_SEGMENT,
    carried: readonly SegmentMessage[] = [],
    private readonly sealed: ReadonlySet<string> = new Set(),
  ) {
    this.accepted = header.accepted;
    for (const { order, message } of [...carried].sort((a, b) => a.order - b.order))
      this.held.set(message.id, { order, message });
  }

  /** The message held here under `id`, as it stands now. */
  message(id: string): VersionedMessage | undefined {
    return this.held.get(id)?.message;
  }

  /** How many events this segment has applied: the log's rotation counts these. */
  get events(): number {
    return this.applied;
  }

  /** The position the queue has reached: the next segment's `base`. */
  get position(): number {
    return this.header.base + this.applied;
  }

  /** How many messages the queue has accepted so far: the next segment's `accepted`. */
  get acceptedCount(): number {
    return this.accepted;
  }

  /** Every message this segment holds, carried ones first, in the order they were first accepted. */
  get messages(): readonly HeldMessage[] {
    return [...this.held.values()];
  }

  apply(event: QueueEvent): void {
    this.applied += 1;
    const position = this.header.base + this.applied;
    if (event.kind === 'enqueued') {
      if (this.held.has(event.message.id) || this.sealed.has(event.message.id)) return;
      this.held.set(event.message.id, {
        order: this.accepted,
        message: { ...event.message, version: position },
      });
      this.accepted += 1;
      return;
    }
    const current = this.held.get(event.id);
    if (current === undefined) return;
    const next = applied(current.message, event);
    if (next !== current.message)
      this.held.set(event.id, { order: current.order, message: { ...next, version: position } });
  }
}

/**
 * The messages a log describes, in the order they were first accepted.
 *
 * An `enqueued` line for an id already held is a retried request and changes nothing; any other line for
 * an id never enqueued is ignored, since there is no message for it to move. This is the WHOLE queue folded from its
 * first event with no rotation: the rotated store is proven against it.
 */
export function foldQueue(events: readonly QueueEvent[]): readonly QueuedMessage[] {
  const fold = new SegmentFold();
  for (const event of events) fold.apply(event);
  return fold.messages.map(held => held.message);
}
