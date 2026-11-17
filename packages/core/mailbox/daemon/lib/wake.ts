import { AGENT_ORIGIN, type FerretId } from '@ferretry/core-ferrets/contract';
import type { WakeDelivery, WakeReceipt } from '@ferretry/core-ferrets/contract';
import { QueueRefused, SendRefused, type SendResult, parseSessionId } from '../../contract/index.ts';
import type { MailboxParts } from '../mailbox-api.ts';
import { MailboxHostMissingError } from './host-slot.ts';
import { SessionSendError } from './delivery/mounts/session-send.ts';

/** Where a wake stands once the Mailbox kept it: still waiting its turn, or typed into the pane. */
const stateOf = (result: SendResult): 'queued' | 'delivered' =>
  result.disposition === 'queued' || result.disposition === 'queued-for-revive' ? 'queued' : 'delivered';

/** A refusal the Mailbox words itself: nothing was kept, and saying why is all a wake needs. */
const isRefusal = (error: unknown): error is Error =>
  error instanceof SessionSendError ||
  error instanceof SendRefused ||
  error instanceof QueueRefused ||
  error instanceof MailboxHostMissingError;

/**
 * THE MAILBOX'S ANSWER TO `ferrets.wake`: a woken ferret is told its wait is over by a queued message from Ferretry ·
 * Monitor, so the wake is on disk before it is answered, waits behind a draft or a dialog and is looked at again, shows on
 * the queue screen, and carries the receipt every other message does.
 *
 * `key` is the park's own (`wake:<session>:<since>`), the message's id in the queue and the send ledger, so a repeat (the
 * monitor's next tick, or a restart's retry) is the same message and never a second wake. A wake never revives a stopped
 * ferret, and one to a ferret the owner is chatting with is typed directly (a daemon message never waits in an owner's chat).
 * Built over `parts()`, which is lazy like every other act, so the send half is made on the first wake, not at boot.
 */
export function wakeDelivery(parts: () => MailboxParts): WakeDelivery {
  return {
    wake: async (ferret: FerretId, request): Promise<WakeReceipt> => {
      try {
        const { send } = parts();
        const id = parseSessionId(ferret);
        const result =
          (await send.keptSend(id, request.key)) ??
          (await send.submit(id, { sendId: request.key, message: request.text, origin: AGENT_ORIGIN, monitor: true }));
        return { kind: 'accepted', sendId: request.key, state: stateOf(result) };
      } catch (error) {
        if (isRefusal(error)) return { kind: 'refused', reason: error.message };
        throw error;
      }
    },
  };
}
