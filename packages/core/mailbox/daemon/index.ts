import { err, ok } from '@ferretry/std';
import { implementDaemon } from '@ferretry/kernel/manifest';
import {
  KeyedSerialExecutor,
  type MailboxQueueApi,
  MailboxHosts,
  QueueChanged,
  QueueRefused,
  SessionQueueService,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { MAILBOX_HOST_MISSING, type MailboxHostSource, requireMailboxHost } from './lib/host-slot.ts';
import { NotifyingSessionQueueStore } from './lib/queue/notifying-store.ts';

/**
 * The Mailbox's daemon half. It serves the queue (the one writer of a ferret's queue log, and the one place a change
 * of it is announced) and checks its one slot where a person can see it. The kernel never fails a boot over a
 * `beforeListen`, so "loud" is: an error line in the daemon log at boot and a failing `fy doctor` row (`mailbox-host`),
 * and every later use of the host refuses with {@link MAILBOX_HOST_MISSING}.
 */
export default implementDaemon(manifest, {
  build: ({ hooks, kernel }) => {
    const source: MailboxHostSource = key => hooks.provider(MailboxHosts, key);
    // The slot's value only exists once Conversation has built, so the service is made on first use.
    let made: SessionQueueService | undefined;
    const service = (): SessionQueueService => {
      made ??= new SessionQueueService({
        store: new NotifyingSessionQueueStore(requireMailboxHost(source).queue, {
          publish: async (id, _type, data) => {
            await kernel.events.publish(QueueChanged, { ferret: id, message: data.messageId, change: data.change });
          },
        }),
        clock: { now: () => kernel.clock.now() },
        serial: new KeyedSerialExecutor(),
      });
      return made;
    };
    const refusal = (error: unknown) => {
      if (error instanceof QueueRefused) return err({ code: error.refusal, message: error.message });
      throw error;
    };
    const queue: MailboxQueueApi = {
      queue: async ferret => ({ messages: [...(await service().list(ferret))] }),
      editQueued: async (ferret, message, request) => {
        try {
          return ok(await service().edit(ferret, message, request.text));
        } catch (error) {
          return refusal(error);
        }
      },
      cancelQueued: async (ferret, message) => {
        try {
          return ok(await service().cancel(ferret, message));
        } catch (error) {
          return refusal(error);
        }
      },
    };
    return {
      provides: { mailbox: queue },
      doctor: {
        'mailbox-host': async () => {
          try {
            requireMailboxHost(source);
            return { state: 'ok', detail: 'Conversation provides the queue and send ledger' };
          } catch {
            return { state: 'fail', detail: MAILBOX_HOST_MISSING, fix: 'turn Conversation on, or see why it failed' };
          }
        },
      },
      beforeListen: async ({ kernel: booted }) => {
        try {
          requireMailboxHost(source);
        } catch {
          booted.log.error(MAILBOX_HOST_MISSING);
        }
      },
    };
  },
});
