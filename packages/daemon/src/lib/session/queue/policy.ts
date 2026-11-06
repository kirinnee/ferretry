import type { InteractionMode, PeerMessageLabel, QueuedMessage, SendSenderKind } from '@ferretry/protocol';
import { type SendTarget, TERMINAL_SEND_STATUSES } from '../send/types.ts';
import type { QueueCoalesceSettings } from './settings.ts';

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

/** What a ferret's message IS for delivery, once the live state of its receiver is read. */
export type EffectiveLabel = PeerMessageLabel;

/** Whether a ferret's message answers a question its receiver is parked on (the same test as the banner's `reply`). */
function answersWait(message: QueuedMessage, target: SendTarget): boolean {
  return target.waiting?.peer !== undefined && target.waiting.peer === message.from;
}

/**
 * How a ferret's message is to be treated NOW. A blocker, an interrupt (`--now`), the answer its receiver
 * is parked on, a question (a reply is expected) and every message while the kill switch is off all go at
 * once — a question is never held, as news or to be combined. No label is an action.
 */
export function effectiveLabel(
  message: QueuedMessage,
  target: SendTarget,
  settings: Pick<QueueCoalesceSettings, 'coalesce'>,
): EffectiveLabel {
  if (
    !settings.coalesce ||
    message.label === 'blocker' ||
    message.interrupt === true ||
    message.replyExpected === true ||
    answersWait(message, target)
  )
    return 'blocker';
  return message.label === 'fyi' ? 'fyi' : 'action';
}

/** Whether the receiver ended a turn after this message arrived. A turn end BEFORE it does not count. */
function turnEndedSince(message: QueuedMessage, target: SendTarget): boolean {
  return (
    target.turnState === 'your-turn' &&
    target.turnStateAt !== undefined &&
    Date.parse(target.turnStateAt) > Date.parse(message.enqueuedAt)
  );
}

/** Whether a ferret's message may go now: a blocker always, an action at its hold, an FYI at a turn end or its cap. */
function isDue(message: QueuedMessage, label: EffectiveLabel, target: SendTarget, now: number): boolean {
  if (label === 'blocker') return true;
  const expired = message.holdUntil === undefined || now >= Date.parse(message.holdUntil);
  return label === 'fyi' ? expired || turnEndedSince(message, target) : expired;
}

/** What the deliverer does next with a session's queue. */
export type DeliveryPlan =
  /** One message, alone, under its own id. */
  | { readonly kind: 'single'; readonly message: QueuedMessage }
  /** Two or more ferret messages as ONE turn, oldest first. */
  | { readonly kind: 'batch'; readonly members: readonly QueuedMessage[] }
  /**
   * Nothing goes yet. `until` is when the earliest hold ends; without one only a state change frees it.
   * `reason` is set when something other than time is in the way (a stopped session an FYI will not revive).
   */
  | { readonly kind: 'hold'; readonly until?: string; readonly reason?: 'stopped' };

/** What `planDelivery` reads of the session. */
export type PlanView = { readonly target: SendTarget };

/** Every status from which an FYI alone must not revive the session. */
const isStopped = (target: SendTarget): boolean => TERMINAL_SEND_STATUSES.has(target.status);

/**
 * WHAT TO DELIVER NEXT, and whether to deliver yet — the one decision for a session's queue. Pure: the
 * clock and the receiver's live state come in as arguments.
 *
 *  1. A message `typing` stops everything: one is in flight at a time.
 *  2. A person's message goes at once, alone, never combined — so its bubble, its read tick and the
 *     agenda's reply stay one-to-one with what was typed.
 *  3. A ferret's message that is DUE (see `isDue`) flushes every pending ferret message with it, in
 *     acceptance order, up to `batchMax`: a blocker carries the actions and FYIs waiting, a due action
 *     carries the FYIs. Everything within the window of the first rides in one turn.
 *  4. The daemon's message (Warden, Board, Agenda) goes at once, alone, and is never held — it may pass a
 *     ferret message still being held, but never one that is due.
 *  5. Otherwise the session holds until the earliest hold ends.
 *
 * FYIs alone are not delivered to a stopped session — an FYI never revives a ferret — but they never hold
 * the daemon's message behind them, and any blocker or action in the queue releases them in order.
 */
export function planDelivery(
  messages: readonly QueuedMessage[],
  view: PlanView,
  now: string,
  settings: QueueCoalesceSettings,
): DeliveryPlan | undefined {
  if (messages.some(message => message.state === 'typing')) return undefined;
  const waiting = deliveryOrder(messages, view.target.mode);
  if (waiting.length === 0) return undefined;
  const human = waiting.find(message => message.sender === 'human');
  if (human !== undefined) return { kind: 'single', message: human };

  const instant = Date.parse(now);
  const ferrets = waiting
    .filter(message => message.sender === 'agent')
    .map(message => ({ message, label: effectiveLabel(message, view.target, settings) }));
  let stoppedFyis = false;
  if (ferrets.some(entry => isDue(entry.message, entry.label, view.target, instant))) {
    // The kill switch is today's queue: one turn per message.
    // An FYI never revives a stopped session — judged on the WHOLE pending queue, not the capped prefix:
    // twenty FYIs ahead of a blocker must drain (in order) so the blocker's turn comes, not wedge it.
    if (!(isStopped(view.target) && ferrets.every(entry => entry.label === 'fyi'))) {
      const members = ferrets.slice(0, settings.coalesce ? Math.max(1, settings.batchMax) : 1);
      const flushed = members.map(entry => entry.message);
      const [only, ...rest] = flushed;
      return only !== undefined && rest.length === 0
        ? { kind: 'single', message: only }
        : { kind: 'batch', members: flushed };
    }
    stoppedFyis = true;
  }

  const daemon = waiting.find(message => message.sender === 'daemon');
  if (daemon !== undefined) return { kind: 'single', message: daemon };
  if (stoppedFyis) return { kind: 'hold', reason: 'stopped' };
  const until = ferrets
    .flatMap(entry => (entry.message.holdUntil === undefined ? [] : [entry.message.holdUntil]))
    .toSorted((left, right) => Date.parse(left) - Date.parse(right))[0];
  return { kind: 'hold', ...(until === undefined ? {} : { until }) };
}
