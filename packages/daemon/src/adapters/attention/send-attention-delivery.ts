import {
  type AttentionComposer,
  type AttentionComposerState,
  type AttentionMessenger,
  AttentionNotTyped,
  type AttentionReceipt,
  type AttentionReceipts,
} from '../../lib/attention/index.ts';
import type { SessionSendService } from '../../lib/session/send/service.ts';
import { sameSendId } from '../../lib/session/send/index.ts';
import {
  SendDraftRefused,
  type SendFate,
  type SendLedger,
  SendPending,
  SendScreenUnreadable,
  type SendTerminal,
  SendUnconfirmed,
} from '../../lib/session/send/types.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';

/**
 * THE ATTENTION OUTBOX'S WAY THROUGH THE ORDINARY SEND PATH (docs/attention.md § Delivery): the send
 * service types it, the pane says whether the composer is empty, and the send ledger says whether it
 * arrived. Each is read, never re-derived, so the outbox and a person's own send agree on all three.
 */

/**
 * Sends a batch through the send service, telling the outbox which refusals typed NOTHING and may be tried
 * again (a draft in the composer, a screen that could not be read, a ferret still starting) from the ones
 * that would refuse again. A send typed but not yet proven to land is accepted: its receipt decides.
 */
export class SendAttentionMessenger implements AttentionMessenger {
  constructor(private readonly sends: Pick<SessionSendService, 'send'>) {}

  async send(sessionId: string, message: string, sendId: string): Promise<void> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) throw new Error(`not a session id: ${sessionId}`);
    try {
      await this.sends.send({ id, sendId, message });
    } catch (error) {
      if (error instanceof SendUnconfirmed) return;
      if (error instanceof SendDraftRefused || error instanceof SendScreenUnreadable || error instanceof SendPending)
        throw new AttentionNotTyped(error.message);
      throw error;
    }
  }
}

/**
 * The ferret's composer as the send path reads it. The pane reader already leaves Claude's dim ghost
 * suggestion out of `draft`, so a suggestion reads as empty and a person's text as occupied. A pane that is
 * gone holds no draft: the send path revives the ferret with the message as its first turn.
 */
export class PaneAttentionComposer implements AttentionComposer {
  constructor(private readonly terminal: Pick<SendTerminal, 'observe'>) {}

  async state(sessionId: string): Promise<AttentionComposerState> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return 'unreadable';
    const pane = await this.terminal.observe(id).catch(() => undefined);
    if (pane === undefined) return 'unreadable';
    if (!pane.alive || pane.dead) return 'empty';
    return pane.draft === undefined || pane.draft.trim() === '' ? 'empty' : 'occupied';
  }
}

/** The words an undelivered card carries for each fate that is not a delivery. */
const FAILED_FATES: Partial<Readonly<Record<SendFate, string>>> = {
  timed_out: 'it never appeared in the ferret’s transcript',
  unaccounted: 'nothing proves it reached the ferret',
  withdrawn: 'nothing was typed to the ferret',
  cancelled: 'the send was cancelled',
};

/**
 * Reads a batch's fate from the send ledger: `delivered` only when the tracker proved it in the transcript;
 * a proven absence, an outcome nobody can prove, a withdrawal or a cancel failed; anything still open (or
 * not yet written) pending.
 */
export class LedgerAttentionReceipts implements AttentionReceipts {
  constructor(private readonly ledger: Pick<SendLedger, 'list'>) {}

  async receipt(sessionId: string, sendId: string): Promise<AttentionReceipt> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return { state: 'failed', reason: 'the ferret could not be found' };
    const record = (await this.ledger.list(id)).find(each => sameSendId(each.sendId, sendId));
    if (record?.fate === 'delivered') return { state: 'delivered' };
    const reason = record?.fate === undefined ? undefined : FAILED_FATES[record.fate];
    return reason === undefined ? { state: 'pending' } : { state: 'failed', reason };
  }
}
