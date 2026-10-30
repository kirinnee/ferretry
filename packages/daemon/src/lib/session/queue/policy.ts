import type { InteractionMode, QueuedMessage, SendSenderKind } from '@ferretry/protocol';

/**
 * WHO GOES FIRST. A person's message is delivered before any ferret's, and a ferret's before the daemon's;
 * within one sender kind, in the order they were accepted. On 2026-10-30 the owner's message waited behind
 * nine Warden notices typed into the same pane; under this order it would have gone first.
 */
const SENDER_RANK: Readonly<Record<SendSenderKind, number>> = { human: 0, agent: 1, daemon: 2 };

/**
 * A daemon notice to an INTERACTIVE session is never typed into it: that session is the owner's own chat,
 * where a notice lands in the middle of their conversation, or sits unsent in its composer ahead of what
 * they type. It belongs on the session's board, not in its queue's delivery order.
 */
export function boardOnly(message: Pick<QueuedMessage, 'sender'>, mode: InteractionMode): boolean {
  return message.sender === 'daemon' && mode === 'interactive';
}

/** The `queued` messages that may be typed into a session of this mode, in the order they are to go. */
export function deliveryOrder(messages: readonly QueuedMessage[], mode: InteractionMode): readonly QueuedMessage[] {
  const accepted = new Map(messages.map((message, index) => [message.id, index]));
  return messages
    .filter(message => message.state === 'queued' && !boardOnly(message, mode))
    .toSorted(
      (left, right) =>
        SENDER_RANK[left.sender] - SENDER_RANK[right.sender] ||
        Date.parse(left.enqueuedAt) - Date.parse(right.enqueuedAt) ||
        (accepted.get(left.id) ?? 0) - (accepted.get(right.id) ?? 0),
    );
}

/**
 * The one message to type next, or `undefined` when none may go now.
 *
 * ONE AT A TIME: while a message is `typing` nothing else is, because two fills racing for one composer is
 * how two messages became one joined message, and how one became three copies.
 */
export function nextToDeliver(messages: readonly QueuedMessage[], mode: InteractionMode): QueuedMessage | undefined {
  if (messages.some(message => message.state === 'typing')) return undefined;
  return deliveryOrder(messages, mode)[0];
}
