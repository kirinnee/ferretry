import type { QueuedMessage, QueuedMessageState, QueueWaitReason } from '@ferretry/protocol';
import type { SendFate, SendPaneObservation, SendTarget } from '../send/types.ts';

/**
 * WHEN A QUEUED MESSAGE MAY GO, and where one already handed over stands — the pure half of delivery.
 *
 * THE OWNER'S RULE (2026-10-30): "it should submit even if a conversation is working. Ready just means
 * the input box is empty." So a message is held only for what would make typing wrong — a draft in the
 * box, a question or dialog on screen, a session still starting — never because a turn is running: the
 * harness queues text typed mid-turn itself.
 */

/** What delivery reads of a session before it types: its record, its pane, and whether it is starting. */
export interface DeliveryView {
  readonly target: SendTarget;
  readonly pane: SendPaneObservation;
  readonly launching: boolean;
}

/**
 * Why nothing may be typed into this session now, or `undefined` when its input box is free.
 *
 * A stopped session is NOT held: the send path revives it with the message as its first turn, exactly as
 * a person's send to it does today. A pane that cannot be read is the caller's to say (`unreadable`).
 */
export function waitReasonOf(view: DeliveryView): QueueWaitReason | undefined {
  if (view.launching) return 'launching';
  if (view.target.pendingQuestion !== undefined) return 'question';
  if (!view.pane.alive || view.pane.dead) return undefined;
  if (view.pane.blockingPrompt !== undefined) return 'dialog';
  if (view.pane.draft !== undefined && view.pane.draft.trim() !== '') return 'draft';
  return undefined;
}

/** What one hand-over to the send path did. */
export type HandOver =
  /** The pane proved it: submitted as a turn, or held in the harness's own queue. */
  | { readonly kind: 'landed' }
  /** Keys went to the pane and nothing has proven where they went yet; the send ledger will. */
  | { readonly kind: 'unproven' }
  /** Nothing was typed, and this is why: the message waits again. */
  | { readonly kind: 'refused'; readonly reason: QueueWaitReason }
  /** Nothing was typed, and nothing will change that by waiting. */
  | { readonly kind: 'failed'; readonly failure: string };

/** One move a message makes, with the failure it carries when it fails. */
export interface QueueMove {
  readonly state: QueuedMessageState;
  readonly failure?: string;
}

/**
 * The moves that bring a message handed to the send path up to what the send ledger now proves.
 *
 * The ledger is keyed by the message's own id, so its fate IS this message's: `queued` (held in the
 * harness's queue) is delivered, `delivered` (a user record in the transcript) is read. A message
 * `typing` with no ledger record, or a withdrawn one, never had a key typed — a daemon that stopped
 * between the two writes — and simply waits again. Nothing here ever types it again: a fate that cannot
 * say whether it landed fails, in words that say it may have.
 */
export function movesFrom(message: QueuedMessage, fate: SendFate | undefined): readonly QueueMove[] {
  if (message.state === 'typing') {
    switch (fate) {
      case undefined:
      case 'withdrawn':
        return [{ state: 'queued' }];
      case 'accepted':
        return [];
      case 'queued':
        return [{ state: 'delivered' }];
      case 'delivered':
        return [{ state: 'delivered' }, { state: 'read' }];
      case 'timed_out':
        return [{ state: 'failed', failure: 'it never reached the agent' }];
      case 'unaccounted':
        return [{ state: 'failed', failure: 'nothing proves it reached the agent, though it may have' }];
      case 'cancelled':
        return [{ state: 'failed', failure: 'its send was cancelled' }];
    }
  }
  return message.state === 'delivered' && fate === 'delivered' ? [{ state: 'read' }] : [];
}
