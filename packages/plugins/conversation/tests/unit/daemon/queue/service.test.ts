import type { Instant } from '@ferretry/std';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  defaultQueueCoalesceSettings,
  type QueueEvent,
  QueueRefused,
  SessionQueueService,
  type SessionQueueStore,
} from '../../../../daemon/seams/index.ts';
import { parseSessionId, type SessionId } from '../../../../daemon/seams/ferret-id.ts';

const ID = parseSessionId('session-1');

/** The store as a list per session, with every append on record. */
class MemoryQueueStore implements SessionQueueStore {
  readonly logs = new Map<string, QueueEvent[]>();

  async read(id: SessionId): Promise<readonly QueueEvent[]> {
    return [...(this.logs.get(id) ?? [])];
  }

  async append(id: SessionId, event: QueueEvent): Promise<void> {
    this.logs.set(id, [...(this.logs.get(id) ?? []), event]);
  }
}

function subject() {
  const store = new MemoryQueueStore();
  let seconds = 0;
  const service = new SessionQueueService({
    store,
    clock: { now: () => new Date(Date.UTC(2026, 9, 30, 13, 0, seconds++)).toISOString() as Instant },
    serial: { run: async (_key, work) => await work(), runExclusive: async work => await work() },
  });
  return { store, service };
}

describe('accepting a message', () => {
  it('should write it queued, at revision 1, before answering — the first tick', async () => {
    const { store, service } = subject();

    const { message, created } = await service.enqueue(ID, {
      id: 'm1',
      sender: 'agent',
      from: 'session-2',
      fromName: 'ada',
      text: 'ship it',
      attachmentIds: ['att-1'],
    });

    should(created).be.true();
    should(message).containEql({ state: 'queued', revision: 1, sender: 'agent', from: 'session-2', fromName: 'ada' });
    should(message.attachmentIds).eql(['att-1']);
    should(message).not.have.property('by');
    should(store.logs.get(ID)).have.length(1);
    // The read side stamps the log position of its latest change; the answer to the write was made before it was read back.
    should(await service.list(ID)).deepEqual([{ ...message, version: 1 }]);
  });

  it('should answer a retried request from the first message, writing nothing', async () => {
    const { store, service } = subject();
    const first = await service.enqueue(ID, { id: 'm1', sender: 'human', text: 'ship it' });

    const second = await service.enqueue(ID, { id: 'm1', sender: 'human', text: 'ship it' });

    should(second).deepEqual({ message: { ...first.message, version: 1 }, created: false });
    should(first.message).not.have.property('from');
    should(first.message).not.have.property('replyExpected');
    should(first.message.attachmentIds).eql([]);
    should(store.logs.get(ID)).have.length(1);
  });
});

describe('a message whose sender waits for the reply', () => {
  it('should keep that the reply is expected, so the agent is told how to unblock them', async () => {
    const { service } = subject();

    const { message } = await service.enqueue(ID, { id: 'm1', sender: 'agent', text: 'ok?', replyExpected: true });

    should(message.replyExpected).be.true();
  });

  it('should keep who a message is from as metadata, beside words it leaves as they are', async () => {
    const { service } = subject();

    const { message } = await service.enqueue(ID, {
      id: 'b1',
      sender: 'daemon',
      by: { kind: 'ferretry', feature: 'Board' },
      text: '&F1 has had no activity for 3h in Implement. Move it, note why, block it, or drop it.',
    });
    const plain = await service.enqueue(ID, { id: 'b2', sender: 'daemon', text: 'nudge' });

    should(message.by).eql({ kind: 'ferretry', feature: 'Board' });
    should(message.text).equal('&F1 has had no activity for 3h in Implement. Move it, note why, block it, or drop it.');
    should(plain.message).not.have.property('by');
    should(plain.message).not.have.property('chat');
  });
});

describe('who a message is from', () => {
  it('should keep it as data on the message, for the app’s sender chip', async () => {
    const { service } = subject();

    const { message } = await service.enqueue(ID, {
      id: 'm2',
      sender: 'agent',
      by: { kind: 'ferret', name: 'ada' },
      text: 'hi',
    });

    should(message.by).deepEqual({ kind: 'ferret', name: 'ada' });
    should(message.text).equal('hi');
  });
});

describe('a message that stops the running turn first', () => {
  it('should keep the interrupt flag on the queued message, and none on an ordinary one', async () => {
    const { service } = subject();

    const urgent = await service.enqueue(ID, { id: 'i1', sender: 'human', text: 'stop', interrupt: true });
    const plain = await service.enqueue(ID, { id: 'i2', sender: 'human', text: 'later' });

    should(urgent.message.interrupt).be.true();
    should(plain.message).not.have.property('interrupt');
  });
});

describe('changing a message that still waits', () => {
  it('should edit it as the next revision, and cancel it', async () => {
    const { service } = subject();
    await service.enqueue(ID, { id: 'm1', sender: 'human', text: 'ship it' });

    const edited = await service.edit(ID, 'm1', 'ship it now');
    const cancelled = await service.cancel(ID, 'm1');

    should(edited).containEql({ text: 'ship it now', revision: 2 });
    should(cancelled).containEql({ state: 'cancelled', text: 'ship it now' });
    should(await service.list(ID)).deepEqual([{ ...cancelled, version: 3 }]); // enqueued, edited, cancelled: its third line
  });

  it('should refuse a message it does not hold, and one that no longer waits', async () => {
    const { service } = subject();
    await service.enqueue(ID, { id: 'm1', sender: 'human', text: 'ship it' });
    await service.cancel(ID, 'm1');

    const missing = await service.edit(ID, 'ghost', 'x').catch((error: unknown) => error);
    const gone = await service.cancel(ID, 'm1').catch((error: unknown) => error);

    should(missing).be.instanceof(QueueRefused);
    should((missing as QueueRefused).refusal).equal('not_found');
    should((gone as QueueRefused).refusal).equal('not_waiting');
    should((gone as QueueRefused).message).match(/is cancelled, so it can no longer be cancelled/u);
  });
});

describe('how long a ferret message is held', () => {
  const agent = { sender: 'agent' as const, text: 'note' };
  const heldMs = (message: { enqueuedAt: string; holdUntil?: string | undefined }): number | undefined =>
    message.holdUntil === undefined ? undefined : Date.parse(message.holdUntil) - Date.parse(message.enqueuedAt);

  it('should default an unlabelled ferret message to an action held for the 60 s window', async () => {
    const { service } = subject();

    const { message } = await service.enqueue(ID, { ...agent, id: 'a' });

    should(message.label).equal('action');
    should(heldMs(message)).equal(60_000);
  });

  it('should hold an FYI for the 10 minute cap at most', async () => {
    const { service } = subject();

    const { message } = await service.enqueue(ID, { ...agent, id: 'f', label: 'fyi' });

    should(message.label).equal('fyi');
    should(heldMs(message)).equal(600_000);
  });

  it('should never hold a question, whatever label it arrives with or without', async () => {
    const { service } = subject();

    for (const label of ['fyi', 'action', undefined] as const) {
      const { message } = await service.enqueue(ID, {
        ...agent,
        id: `q-${label}`,
        ...(label === undefined ? {} : { label }),
        replyExpected: true,
      });

      should(message).not.have.property('holdUntil');
      should(message).have.property('label', 'blocker');
    }
  });

  it('should never hold a blocker or an interrupt', async () => {
    const { service } = subject();

    const blocker = await service.enqueue(ID, { ...agent, id: 'b', label: 'blocker' });
    const now = await service.enqueue(ID, { ...agent, id: 'n', interrupt: true });

    should(blocker.message).not.have.property('holdUntil');
    should(now.message).not.have.property('holdUntil');
  });

  it("should never label or hold the owner's message or the daemon's", async () => {
    const { service } = subject();

    const owner = await service.enqueue(ID, { id: 'o', sender: 'human', text: 'hi', label: 'fyi' });
    const warden = await service.enqueue(ID, { id: 'w', sender: 'daemon', text: 'alert', label: 'fyi' });

    for (const { message } of [owner, warden]) {
      should(message).not.have.property('label');
      should(message).not.have.property('holdUntil');
    }
  });

  it('should hold nothing, and call everything a blocker, with the kill switch off', async () => {
    const store = new MemoryQueueStore();
    const service = new SessionQueueService(
      {
        store,
        clock: { now: () => new Date(Date.UTC(2026, 9, 30, 13, 0, 0)).toISOString() as Instant },
        serial: { run: async (_key, work) => await work(), runExclusive: async work => await work() },
      },
      { ...defaultQueueCoalesceSettings, coalesce: false },
    );

    const { message } = await service.enqueue(ID, { ...agent, id: 'f', label: 'fyi' });

    should(message).not.have.property('holdUntil');
  });

  it('should use the configured window and cap', async () => {
    const service = new SessionQueueService(
      {
        store: new MemoryQueueStore(),
        clock: { now: () => new Date(Date.UTC(2026, 9, 30, 13, 0, 0)).toISOString() as Instant },
        serial: { run: async (_key, work) => await work(), runExclusive: async work => await work() },
      },
      { ...defaultQueueCoalesceSettings, actionWindowMs: 5_000, fyiMaxHoldMs: 9_000 },
    );

    const action = await service.enqueue(ID, { ...agent, id: 'a' });
    const fyi = await service.enqueue(ID, { ...agent, id: 'f', label: 'fyi' });

    should([heldMs(action.message), heldMs(fyi.message)]).eql([5_000, 9_000]);
  });
});
