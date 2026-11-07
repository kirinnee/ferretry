import type { QueuedMessage, QueueWaitReason, SendDisposition, SendFate } from '../../seams/protocol.ts';
import { dispositionOf, type SendRecord } from '../../delivery/lib/types.ts';

/**
 * What a sender is told once the deliverer's first look at its message is over: what the send ledger —
 * keyed by the message's own id — then says, or `queued` when the message is still waiting in the queue.
 *
 * A send that went straight into an empty box is answered exactly as the direct path answered it; one
 * held for a draft, a question or a dialog is answered at once as queued, and the queue says why.
 *
 * B144: "queued" alone read to every sender as "in the agent's own queue, it submits at the turn
 * boundary" — for messages that had never been typed, waiting in FERRETRY's queue behind a send of ours
 * stuck unsubmitted in an idle ferret's box. So a message the ledger has no record of carries the queue's
 * own reason, and the send it waits behind when that is ours.
 */
export function answerOf(
  record: SendRecord | undefined,
  waiting?: Pick<QueuedMessage, 'state' | 'waitReason' | 'waitBehind'>,
): {
  readonly disposition: SendDisposition;
  readonly fate: SendFate;
  readonly waitReason?: QueueWaitReason;
  readonly waitBehind?: string;
} {
  // A WITHDRAWN row is a hand-over the pane refused before any key: the message went back to the queue, so
  // the queue says where it is — never the path the refused attempt would have taken ("delivered").
  if (record === undefined || record.fate === 'withdrawn') {
    const reason = waiting?.state === 'queued' ? waiting.waitReason : undefined;
    return {
      disposition: 'queued',
      fate: 'accepted',
      ...(reason === undefined ? {} : { waitReason: reason }),
      ...(reason === undefined || waiting?.waitBehind === undefined ? {} : { waitBehind: waiting.waitBehind }),
    };
  }
  const disposition = record.held === true ? 'queued-for-revive' : dispositionOf(record.path, record.fate === 'queued');
  return { disposition, fate: record.fate };
}
