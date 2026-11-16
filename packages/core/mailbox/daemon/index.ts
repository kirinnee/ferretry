import { err, ok } from '@ferretry/std';
import { implementDaemon } from '@ferretry/kernel/manifest';
import type { RouteHandler } from '@ferretry/kernel/contract';
import {
  DeliveryWays,
  KeyedSerialExecutor,
  MailboxHosts,
  type MailboxApi,
  type MailboxHost,
  type MailboxQueueApi,
  QueueChanged,
  QueueRefused,
} from '../contract/index.ts';
import { SessionQueueService } from './lib/queue/service.ts';
import manifest from '../manifest.ts';
import { paneWayContributions } from './ways/pane-way.ts';
import { waysDoctor } from './ways/registry.ts';
import { MAILBOX_HOST_MISSING, type MailboxHostSource, requireMailboxHost } from './lib/host-slot.ts';
import { NotifyingSessionQueueStore } from './lib/queue/index.ts';
import { routeTable } from './lib/api.ts';
import { addressedByCallsign } from './lib/ferret-address.ts';
import { maskedBody } from './lib/masked-body.ts';
import { type MailboxParts, sendApi, sendRoutes } from './mailbox-api.ts';
import { buildSendHalf } from './send-half.ts';

/**
 * The Mailbox's daemon half. It serves the queue (the one writer of a ferret's queue log, and the one place a change
 * of it is announced), the send path (the typing send, the tracker, the acts on a send already made, the send and queue
 * routes) and checks its one slot where a person can see it. The kernel never fails a boot over a `beforeListen`, so
 * "loud" is: an error line in the daemon log at boot and a failing `fy doctor` row (`mailbox-host`), and every later use
 * of the host refuses with {@link MAILBOX_HOST_MISSING}.
 */
export default implementDaemon(manifest, {
  build: ({ hooks, kernel, needs }) => {
    const source: MailboxHostSource = key => hooks.provider(MailboxHosts, key);
    // The slot's value only exists once Conversation has built, so everything over it is made on first use: the queue
    // (the one writer, which needs only the host's queue store) first, the send half (which needs all of the host) after.
    let queued:
      | {
          readonly host: MailboxHost;
          readonly queue: SessionQueueService;
          readonly store: NotifyingSessionQueueStore;
          readonly api: MailboxQueueApi;
        }
      | undefined;
    const queueParts = () => {
      if (queued !== undefined) return queued;
      const host = requireMailboxHost(source);
      const store = new NotifyingSessionQueueStore(host.queue, {
        publish: async (id, _type, data) => {
          await kernel.events.publish(QueueChanged, { ferret: id, message: data.messageId, change: data.change });
        },
      });
      const queue = new SessionQueueService({
        store,
        clock: { now: () => kernel.clock.now() },
        serial: new KeyedSerialExecutor(),
      });
      const refusal = (error: unknown) => {
        if (error instanceof QueueRefused) return err({ code: error.refusal, message: error.message });
        throw error;
      };
      const api: MailboxQueueApi = {
        queue: async ferret => ({ messages: [...(await queue.list(ferret))] }),
        editQueued: async (ferret, message, request) => {
          try {
            return ok(await queue.edit(ferret, message, request.text));
          } catch (error) {
            return refusal(error);
          }
        },
        cancelQueued: async (ferret, message) => {
          try {
            return ok(await queue.cancel(ferret, message));
          } catch (error) {
            return refusal(error);
          }
        },
      };
      queued = { host, queue, store, api };
      return queued;
    };
    let made:
      | (MailboxParts & { readonly api: MailboxApi; readonly routes: Readonly<Record<string, RouteHandler>> })
      | undefined;
    const parts = () => {
      if (made !== undefined) return made;
      const { host, queue, store, api: queueApi } = queueParts();
      const send = buildSendHalf({
        kernel,
        ferrets: needs.ferrets,
        queue,
        queueStore: store,
        clock: { now: () => kernel.clock.now() },
        ledger: host.ledger,
        channel: host.channel,
        gate: host.gate,
        evidence: host.evidence,
        boundaries: host.boundaries,
        askedQuestion: host.askedQuestion,
        keepFrame: host.keepFrame,
        stamp: host.stamp,
        transformMessage: host.transformMessage,
        ...(host.attachments === undefined ? {} : { attachments: host.attachments }),
        ...(host.claudeChannel === undefined ? {} : { claude: host.claudeChannel }),
      });
      const base = { kernel, send, queue, ledger: host.ledger };
      made = {
        ...base,
        api: { ...queueApi, ...sendApi(base) },
        routes: routeTable(sendRoutes(base, host.clearSentDraft)),
      };
      return made;
    };
    // A ferret changed: its phase feeds the send tracker's guard; a ferret that went away is forgotten.
    const follow = ({
      ferret,
      state,
      change,
    }: {
      readonly ferret: string;
      readonly state: string;
      readonly change: string;
    }): void => {
      try {
        if (change === 'removed') parts().send.turnForgotten(ferret);
        else parts().send.turnLooked(ferret, state);
      } catch (error) {
        kernel.log.warn(`the Mailbox could not follow a turn of ${ferret}: ${String(error)}`);
      }
    };
    // The queue's three acts need the queue only; every other act needs the send half, built on first use.
    const deferred = <K extends keyof MailboxApi>(key: K, from: () => Partial<MailboxApi>): MailboxApi[K] =>
      (async (...args: never[]) => await (from()[key] as (...a: never[]) => unknown)(...args)) as MailboxApi[K];
    const api = Object.fromEntries([
      ...['queue', 'editQueued', 'cancelQueued'].map(key => [
        key,
        deferred(key as keyof MailboxApi, () => queueParts().api),
      ]),
      ...[
        'send',
        'interrupt',
        'sends',
        'sendRecord',
        'retrySend',
        'cancelSend',
        'enterSend',
        'composer',
        'resubmitStuck',
        'retractedDraft',
        'deliveryLook',
      ].map(key => [key, deferred(key as keyof MailboxApi, () => parts().api)]),
    ]) as unknown as MailboxApi;
    // Stopping lets the hand-over already begun finish (never half a typing), and leaves no timer of the queue running.
    kernel.lifecycle.onStop(async () => await made?.send.stop());
    return {
      routes: Object.fromEntries(
        manifest.actions.routes.map(route => {
          const served: RouteHandler = async context => {
            const handler = parts().routes[route.key];
            if (handler === undefined) throw new Error(`the Mailbox declares ${route.key} and serves none`);
            return await handler(context);
          };
          // A path that names a ferret takes its callsign as well as its id; a body that can show words is masked.
          const addressed = route.key.includes(':ferretId') ? addressedByCallsign(needs.ferrets, served) : served;
          return [route.key, route.guard === 'secrets' ? maskedBody(kernel.redaction, addressed) : addressed];
        }),
      ) as never,
      provides: { mailbox: api },
      hooks: {
        'ferret.changed': follow,
        'mailbox.delivery-way': () => paneWayContributions(needs.ferrets),
      },
      doctor: {
        'mailbox-ways': async () => waysDoctor(() => hooks.contributions(DeliveryWays)),
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
          return;
        }
        try {
          // Built now, not on the first send: a send that was open when the daemon stopped is looked at again at boot.
          parts();
        } catch (error) {
          booted.log.warn(`the Mailbox could not arm its send tracker at boot: ${String(error)}`);
        }
      },
    };
  },
});
