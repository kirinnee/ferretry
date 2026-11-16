import { MAILBOX_HOST_KEY, type MailboxHost } from '../../contract/index.ts';

/** What a provider lookup answers: the host, or `'unavailable'` when no plugin provides the slot. */
export type MailboxHostSource = (key: typeof MAILBOX_HOST_KEY) => MailboxHost | 'unavailable';

/** Said at boot, in `fy doctor` and by every use while the slot is empty. Names the cause and the remedy. */
export const MAILBOX_HOST_MISSING =
  'the Mailbox has no host: Conversation (which keeps the queue and send ledger files) is off or does not provide ' +
  '`mailbox.host`, so no message can be queued or delivered. Turn Conversation on; nothing is sent in the meantime.';

/** Thrown by {@link requireMailboxHost}; a quiet empty store would drop messages without a word, so there is none. */
export class MailboxHostMissingError extends Error {
  constructor() {
    super(MAILBOX_HOST_MISSING);
    this.name = 'MailboxHostMissingError';
  }
}

/** The host, looked up at each use so a Conversation turned on later is used from then on; throws when there is none. */
export function requireMailboxHost(source: MailboxHostSource): MailboxHost {
  const found = source(MAILBOX_HOST_KEY);
  if (found === 'unavailable') throw new MailboxHostMissingError();
  return found;
}
