import type { Instant } from '@ferretry/std';
import { describe, it } from 'bun:test';
import { state as kernelState } from '@ferretry/kernel/host';
import should from 'should';
import { CONVERSATION_STATE } from '../../../../contract/index.ts';
import { StateQueueStore } from '../../../../daemon/queue/adapters/index.ts';
import {
  defaultQueueDeliverySettings,
  QueueDeliverer,
  type QueueDelivery,
} from '../../../../daemon/queue/lib/deliverer.ts';
import type { DeliveryView, HandOver } from '@ferretry/core-mailbox/contract';
import type { QueueEvent } from '@ferretry/core-mailbox/contract';
import { type SessionQueueStore, SessionQueueService } from '@ferretry/core-mailbox/contract';
import type { SendFate } from '../../../../daemon/seams/ledger-types.ts';
import { KeyedSerialExecutor } from '../../../../daemon/seams/keyed-serial-executor.ts';
import { parseSessionId, type SessionId } from '../../../../daemon/seams/ferret-id.ts';

const ID = parseSessionId('session-1');
const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);

/** The real store over a real state port (in memory), the real service and deliverer, and a lock that is checked. */
function world(rotateEvents: number) {
  const fs = kernelState.createMemoryHostFs();
  const port = kernelState.createStatePort({
    home: '/home/fy',
    pluginId: 'conversation',
    files: CONVERSATION_STATE,
    fs,
  });
  const inner = new StateQueueStore(port, rotateEvents);
  const locks = new KeyedSerialExecutor();
  const held = new Set<string>();
  const appended: QueueEvent[] = [];
  const serial = {
    run: async <T>(key: string, work: () => Promise<T>): Promise<T> =>
      await locks.run(key, async () => {
        held.add(key);
        try {
          return await work();
        } finally {
          held.delete(key);
        }
      }),
    runExclusive: async <T>(work: () => Promise<T>): Promise<T> => await locks.runExclusive(work),
  };
  /** Every append is checked to hold the session's queue lock, which is what a rotation relies on. */
  const store: SessionQueueStore = {
    messages: async id => await inner.messages(id),
    append: async (id, event) => {
      if (!held.has(id)) throw new Error(`an append of ${event.kind} did not hold the queue lock`);
      appended.push(event);
      await inner.append(id, event);
    },
  };
  let seconds = 0;
  const clock = { now: () => new Date(T0 + seconds++ * 1_000).toISOString() as Instant };
  const service = new SessionQueueService({ store, clock, serial });
  const handed: string[] = [];
  const fates = new Map<string, SendFate>();
  const answers: HandOver[] = [];
  const deliverer = new QueueDeliverer(
    {
      store,
      serial,
      clock,
      scheduler: { schedule: () => undefined, cancelAll: () => undefined },
      view: async (): Promise<DeliveryView> => ({
        target: { id: ID, status: 'running', mode: 'auto', turn: 4, harness: 'claude' },
        pane: { alive: true, dead: false, promptReady: false, activeWork: true },
        launching: false,
      }),
      transport: {
        handOver: async (_id: SessionId, delivery: QueueDelivery) => {
          handed.push(delivery.sendId);
          return answers.shift() ?? { kind: 'landed' };
        },
        fate: async (_id: SessionId, messageId: string) => fates.get(messageId),
        clearOwnDraft: async () => ({ kind: 'foreign' }),
        recheck: async () => undefined,
      },
      sessions: () => [ID],
      sleep: async () => undefined,
    },
    { ...defaultQueueDeliverySettings },
  );
  return { fs, port, store, service, deliverer, handed, fates, answers, appended, clock };
}

describe('delivering across a rotation of the queue log', () => {
  it('should hand every message over exactly once when the log rotates while one is typing and others wait', async () => {
    const { fs, port, service, deliverer, handed, fates, answers } = world(8);
    await service.enqueue(ID, { id: 'a', sender: 'human', text: 'first' });
    await service.enqueue(ID, { id: 'b', sender: 'human', text: 'second' });
    await service.enqueue(ID, { id: 'c', sender: 'human', text: 'third' });
    // The pane takes `a` but proves nothing: it stays typing, and nothing is typed behind it.
    answers.push({ kind: 'unproven' });
    await deliverer.enqueued(ID);
    should(handed).eql(['a']);

    // Enough traffic from other messages to rotate the log with `a` typing and `b`, `c` waiting.
    for (const pad of ['p1', 'p2', 'p3']) {
      await service.enqueue(ID, { id: pad, sender: 'human', text: pad });
      await service.cancel(ID, pad);
    }
    const shards = [...fs.snapshot().keys()].filter(path => path.includes('/queue-shards/'));
    should(shards.length).be.above(0);
    should((await service.list(ID)).map(entry => [entry.id, entry.state])).eql([
      ['a', 'typing'],
      ['b', 'queued'],
      ['c', 'queued'],
      ['p1', 'cancelled'],
      ['p2', 'cancelled'],
      ['p3', 'cancelled'],
    ]);

    // The ledger proves `a` landed; the deliverer goes on with the rest. A daemon restart in the middle changes nothing.
    fates.set('a', 'delivered');
    await deliverer.changed(ID);
    await deliverer.look(ID);
    await deliverer.look(ID);

    should(handed).eql(['a', 'b', 'c']);
    should((await service.list(ID)).map(entry => [entry.id, entry.state])).eql([
      ['a', 'read'],
      ['b', 'delivered'],
      ['c', 'delivered'],
      ['p1', 'cancelled'],
      ['p2', 'cancelled'],
      ['p3', 'cancelled'],
    ]);
    // A cold start over the files alone hands nothing again.
    const cold = new StateQueueStore(port, 8);
    should((await cold.messages(ID)).filter(entry => entry.state === 'queued')).eql([]);
  });

  it('should hold the queue lock for every append the service and the deliverer make', async () => {
    const { service, deliverer, appended, handed, answers } = world(1_000);
    await service.enqueue(ID, { id: 'a', sender: 'human', text: 'first' });
    await service.enqueue(ID, { id: 'b', sender: 'human', text: 'second' });
    await service.edit(ID, 'b', 'second, revised');
    await service.cancel(ID, 'b');
    answers.push({ kind: 'refused', reason: 'unreadable' });
    await deliverer.enqueued(ID);
    await deliverer.look(ID);

    // A throw from the checked store would have failed one of the calls above; and every kind was written.
    should(new Set(appended.map(event => event.kind))).eql(new Set(['enqueued', 'edited', 'moved', 'waiting']));
    should(handed.length).be.above(0);
  });

  it('should not be able to append outside the lock (the check itself works)', async () => {
    const { store } = world(10);

    await should(
      store.append(ID, {
        v: 1,
        kind: 'moved',
        at: '2026-11-01T08:00:00.000Z' as Instant,
        id: 'a',
        state: 'read',
      }),
    ).be.rejectedWith(/did not hold the queue lock/);
  });
});
