import type { SendDisposition, SendFate } from '@ferretry/protocol';
import { dispositionOf, type SendRecord } from '../send/types.ts';

/**
 * What a sender is told once the deliverer's first look at its message is over: what the send ledger —
 * keyed by the message's own id — then says, or `queued` when the message is still waiting in the queue.
 *
 * A send that went straight into an empty box is answered exactly as the direct path answered it; one
 * held for a draft, a question or a dialog is answered at once as queued, and the queue says why.
 */
export function answerOf(record: SendRecord | undefined): {
  readonly disposition: SendDisposition;
  readonly fate: SendFate;
} {
  if (record === undefined) return { disposition: 'queued', fate: 'accepted' };
  const disposition = record.held === true ? 'queued-for-revive' : dispositionOf(record.path, record.fate === 'queued');
  return { disposition, fate: record.fate === 'withdrawn' ? 'accepted' : record.fate };
}
