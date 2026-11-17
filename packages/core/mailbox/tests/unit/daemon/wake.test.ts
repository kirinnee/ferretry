import type { Instant } from '@ferretry/std';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type DeliveryView,
  foldQueue,
  type InteractionMode,
  parseSessionId,
  type QueueEvent,
  type QueuedMessage,
  type SendPaneObservation,
  type SendResult,
  type SessionQueueStore,
} from '../../../contract/index.ts';
import type { SendMessageRequest } from '../../../daemon/lib/delivery/service.ts';
import type { MailboxParts } from '../../../daemon/mailbox-api.ts';
import { QueueDeliverer, defaultQueueDeliverySettings } from '../../../daemon/lib/queue/deliverer.ts';
import { SessionQueueService } from '../../../daemon/lib/queue/service.ts';
import { Senders } from '../../../daemon/lib/queue/senders.ts';
import { wakeDelivery } from '../../../daemon/lib/wake.ts';
import { SessionSendError } from '../../../daemon/lib/delivery/mounts/session-send.ts';

const ID = parseSessionId('session-1');
const KEY = 'wake:session-1:2026-11-16T10:00:00.000Z';
const TEXT = 'your declared wait is over';
const T0 = Date.UTC(2026, 10, 16, 18, 0, 0);

const pane = (overrides: Partial<SendPaneObservation> = {}): SendPaneObservation => ({
  alive: true,
  dead: false,
  promptReady: true,
  activeWork: false,
  ...overrides,
});

/**
 * The Mailbox's real queue, deliverer and producers over an in-memory log and a pane the test sets, with `submit`
 * standing in for the send half's chooser: the stopped refusal, then `Senders.pick` and the queue.
 */
function world(options: { mode?: InteractionMode; stopped?: boolean } = {}) {
  const log: QueueEvent[] = [];
  const handed: string[] = [];
  const direct: SendMessageRequest[] = [];
  let seconds = 0;
  let current = pane();
  const store: SessionQueueStore = {
    messages: async () => foldQueue(log),
    append: async (_id, event) => void log.push(event),
  };
  const serial = {
    run: async <T>(_key: string, work: () => Promise<T>) => await work(),
    runExclusive: async <T>(work: () => Promise<T>) => await work(),
  };
  const clock = { now: () => new Date(T0 + seconds++ * 1_000).toISOString() as Instant };
  const queue = new SessionQueueService({ store, clock, serial });
  const deliverer = new QueueDeliverer(
    {
      store,
      serial,
      clock,
      scheduler: { schedule: () => undefined, cancelAll: () => undefined },
      view: async (): Promise<DeliveryView> => ({
        target: { id: ID, status: 'running', mode: options.mode ?? 'auto', turn: 1, harness: 'claude' },
        pane: current,
        launching: false,
      }),
      transport: {
        handOver: async (_id, delivery) => {
          handed.push(delivery.sendId);
          return { kind: 'landed' };
        },
        fate: async () => undefined,
        clearOwnDraft: async () => ({ kind: 'foreign' }),
        recheck: async () => undefined,
      },
      sessions: () => [ID],
      sleep: async () => undefined,
    },
    { ...defaultQueueDeliverySettings },
  );
  const answer: SendResult = { ferret: ID, disposition: 'sent', fate: 'accepted' };
  const senders = new Senders({
    queue,
    deliverer,
    direct: {
      send: async request => {
        direct.push(request);
        return answer;
      },
      authorize: async () => undefined,
    },
    target: async () => ({ mode: options.mode ?? 'auto' }),
    timer: () => ({ done: new Promise<void>(() => undefined), cancel: () => undefined }),
  });
  const kept = async (sendId: string): Promise<SendResult | undefined> => {
    const message = foldQueue(log).find(entry => entry.id === sendId);
    return message === undefined
      ? undefined
      : { ferret: ID, disposition: message.state === 'queued' ? 'queued' : 'delivered', sendId, fate: 'accepted' };
  };
  const send = {
    keptSend: async (_ferret: unknown, sendId: string | undefined) =>
      sendId === undefined ? undefined : await kept(sendId),
    submit: async (
      ferret: typeof ID,
      request: { readonly sendId: string; readonly message: string; readonly monitor?: true },
    ): Promise<SendResult> => {
      if (options.stopped === true)
        throw new SessionSendError(
          'refused',
          'the ferret is stopped and a wake never revives it, so nothing was typed',
        );
      const direct = await senders
        .pick({ monitor: request.monitor, unnamedAgent: true })
        .send({ id: ferret, sendId: request.sendId, message: request.message, origin: 'daemon' });
      return direct ?? (await kept(request.sendId)) ?? { ferret, disposition: 'queued', sendId: request.sendId };
    },
  };
  const wake = wakeDelivery(() => ({ send }) as unknown as MailboxParts);
  const queued = (): readonly QueuedMessage[] => foldQueue(log);
  const setPane = (next: SendPaneObservation): void => {
    current = next;
  };
  return { wake, queued, handed, direct, setPane, deliverer };
}

describe('the Mailbox providing ferrets.wake', () => {
  it('should queue the wake under the park’s key as Ferretry · Monitor on the Ferretry lane, and answer accepted', async () => {
    const { wake, queued, handed } = world();

    const receipt = await wake.wake(ID, { key: KEY, text: TEXT });

    should(receipt).eql({ kind: 'accepted', sendId: KEY, state: 'delivered' });
    should(queued()).have.length(1);
    should(queued()[0]).containEql({
      id: KEY,
      sender: 'daemon',
      by: { kind: 'ferretry', feature: 'Monitor' },
      lane: 'ferretry',
      text: TEXT,
    });
    should(handed).eql([KEY]);
  });

  it('should keep ONE message when the same key comes twice, as a restart’s retry does', async () => {
    const { wake, queued, handed } = world();

    await wake.wake(ID, { key: KEY, text: TEXT });
    const again = await wake.wake(ID, { key: KEY, text: TEXT });

    should(again.kind).equal('accepted');
    should(queued()).have.length(1);
    should(handed).eql([KEY]);
  });

  it('should refuse a wake to a stopped ferret with the reason, keeping nothing', async () => {
    const { wake, queued } = world({ stopped: true });

    const receipt = await wake.wake(ID, { key: KEY, text: TEXT });

    should(receipt).eql({
      kind: 'refused',
      reason: 'the ferret is stopped and a wake never revives it, so nothing was typed',
    });
    should(queued()).be.empty();
  });

  it('should leave a wake queued with a reason while a draft is in the box, and deliver it on the next look', async () => {
    const { wake, queued, handed, setPane, deliverer } = world();
    setPane(pane({ draft: 'half a thought' }));

    const receipt = await wake.wake(ID, { key: KEY, text: TEXT });

    should(receipt).eql({ kind: 'accepted', sendId: KEY, state: 'queued' });
    should(queued()[0]).containEql({ state: 'queued', waitReason: 'draft' });
    should(handed).be.empty();

    setPane(pane());
    await deliverer.changed(ID);

    should(handed).eql([KEY]);
    should(queued()[0]?.state).equal('delivered');
  });

  it('should type a wake to an interactive chat directly, never queueing it (R3)', async () => {
    const { wake, queued, direct } = world({ mode: 'interactive' });

    const receipt = await wake.wake(ID, { key: KEY, text: TEXT });

    should(receipt.kind).equal('accepted');
    should(queued()).be.empty();
    should(direct).have.length(1);
    should(direct[0]).containEql({ sendId: KEY, origin: 'daemon', by: { kind: 'ferretry', feature: 'Monitor' } });
  });
});
