import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { SendLedger, SessionQueueStore } from './stores.ts';

/** The one key `mailbox.host` is provided under. */
export const MAILBOX_HOST_KEY = 'ferret' as const;

/**
 * What the Mailbox needs from the plugin that owns a ferret's files and terminals: where its queue and send ledger are
 * kept. Conversation declares and opens `queue.jsonl` and `sends.jsonl` under its own state folder (they never move), so
 * it hands the Mailbox a store and a ledger over them. The Mailbox never opens those files itself.
 *
 * More ports join this object as the delivery code moves in (the existing interfaces, moved, not new ones).
 */
export interface MailboxHost {
  readonly queue: SessionQueueStore;
  readonly ledger: SendLedger;
}

/**
 * `mailbox.host`: the Mailbox's one slot. A security-path provide hook (a message to an agent goes through it), so only
 * Conversation may take it. With no provider the Mailbox does not run a quiet empty store: it says so at boot and
 * answers every use with a refusal that names the cause (see the daemon half).
 */
export const MailboxHosts = defineHook('mailbox.host', {
  mode: 'provide',
  key: z.literal(MAILBOX_HOST_KEY),
  takers: ['conversation'],
  value: z.custom<MailboxHost>(),
});
