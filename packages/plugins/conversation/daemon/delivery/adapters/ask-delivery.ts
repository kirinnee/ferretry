import { type AskDelivery, AskNotTypedError, type AskReceipt } from '@ferretry/core-asks/contract';
import type { ConversationApi } from '../../../contract/port.ts';

/** The refusals that mean "nothing was typed; try again": a draft is in the way, or the ferret is still starting. */
const NOT_TYPED_CODES: ReadonlySet<string> = new Set(['composer_occupied', 'session_launching']);

/**
 * `ask.delivery:ferret` over Conversation's own send path: the owner's answers reach a ferret as a QUEUED,
 * non-interrupting message, so the queue and the send ledger keep them idempotent under `sendId` (a repeat finds the
 * first message and types nothing). Asks never types; it only calls this.
 *
 * The caller is the owner: an agenda answer is the owner's own words.
 */
export function askDeliveryOf(api: Pick<ConversationApi, 'send' | 'sendRecord'>): AskDelivery {
  return {
    send: async (ferret, message, sendId) => {
      const sent = await api.send(ferret as never, { kind: 'owner' }, { message, sendId });
      if (sent.ok) return;
      if (NOT_TYPED_CODES.has(sent.error.code)) throw new AskNotTypedError(sent.error.message);
      throw new Error(sent.error.message);
    },
    // The queue owns ordering (a message waits in it until the composer can take it), so the composer is never the
    // reason to hold an answer back.
    composer: async () => 'empty',
    receipt: async (ferret, sendId): Promise<AskReceipt> => {
      const record = await api.sendRecord(ferret as never, sendId);
      if (record === undefined) return { state: 'pending' };
      switch (record.fate) {
        case 'delivered':
          return { state: 'delivered' };
        case 'accepted':
        case 'queued':
          return { state: 'pending' };
        case 'unaccounted':
          return { state: 'failed', reason: record.unaccountedReason ?? 'unaccounted' };
        default:
          return { state: 'failed', reason: record.fate };
      }
    },
  };
}
