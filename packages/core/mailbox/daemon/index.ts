import { implementDaemon } from '@ferretry/kernel/manifest';
import { MailboxHosts } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { MAILBOX_HOST_MISSING, type MailboxHostSource, requireMailboxHost } from './lib/host-slot.ts';

/**
 * The Mailbox's daemon half. First step (c58-m0a): it serves nothing yet, but it checks its one slot where a person can
 * see it. The kernel never fails a boot over a `beforeListen`, so "loud" is: an error line in the daemon log at boot and
 * a failing `fy doctor` row (`mailbox-host`), and every later use of the host refuses with {@link MAILBOX_HOST_MISSING}.
 */
export default implementDaemon(manifest, {
  build: ({ hooks }) => {
    const source: MailboxHostSource = key => hooks.provider(MailboxHosts, key);
    return {
      doctor: {
        'mailbox-host': async () => {
          try {
            requireMailboxHost(source);
            return { state: 'ok', detail: 'Conversation provides the queue and send ledger' };
          } catch {
            return { state: 'fail', detail: MAILBOX_HOST_MISSING, fix: 'turn Conversation on' };
          }
        },
      },
      beforeListen: async ({ kernel }) => {
        try {
          requireMailboxHost(source);
        } catch {
          kernel.log.error(MAILBOX_HOST_MISSING);
        }
      },
    };
  },
});
