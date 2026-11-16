import type { QueuedMessage, QueuedMessageState, QueueWaitReason } from '../../seams/protocol.ts';
import type { SendFate, SendPaneObservation, SendTarget } from '../../delivery/lib/types.ts';

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
export function reasonForWaiting(view: DeliveryView): QueueWaitReason | undefined {
  if (view.launching) return 'launching';
  if (view.target.pendingQuestion !== undefined) return 'question';
  if (!view.pane.alive || view.pane.dead) return undefined;
  if (view.pane.blockingPrompt !== undefined) return 'dialog';
  // Codex is holding an earlier submission until its startup ends: the pane is still starting, whatever the
  // composer shows.
  if (view.pane.startupParked === true) return 'launching';
  if (view.pane.draft !== undefined && view.pane.draft.trim() !== '') return 'draft';
  return undefined;
}

/**
 * Whose text a composer holding a "draft" is (B144): nobody's any more (`clear` — it was ours, and an Enter
 * took it), a person's (`foreign`), or a send of this session's own the daemon typed and could not get
 * submitted (`stuck`), with whether an Enter was tried on it this time.
 */
export type OwnDraft =
  | { readonly kind: 'clear' }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'stuck'; readonly sendId: string; readonly tried: boolean };

/** What one hand-over to the send path did. */
export type HandOver =
  /** The pane proved it: submitted as a turn, or held in the harness's own queue. */
  | { readonly kind: 'landed' }
  /** Keys went to the pane and nothing has proven where they went yet; the send ledger will. */
  | { readonly kind: 'unproven' }
  /**
   * Nothing was typed, and this is why: the message waits again. `untilPrompt` marks a pane that never came to
   * a prompt (&B153): handing it over again before one shows only waits out the same readiness window.
   */
  | { readonly kind: 'refused'; readonly reason: QueueWaitReason; readonly untilPrompt?: true }
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
 * say whether it landed is `unconfirmed`, never a failure, and a later proof still moves it on.
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
        // May have landed: the owner read "✗ failed, may have reached" for a message the agent had.
        return [{ state: 'unconfirmed' }];
      case 'cancelled':
        return [{ state: 'failed', failure: 'its send was cancelled' }];
    }
  }
  if (message.state === 'unconfirmed')
    return fate === 'delivered' ? [{ state: 'read' }] : fate === 'queued' ? [{ state: 'delivered' }] : [];
  return message.state === 'delivered' && fate === 'delivered' ? [{ state: 'read' }] : [];
}
