import { describe, it } from 'bun:test';
import should from 'should';
import {
  type QueueEvent,
  QueueRefused,
  type SessionQueueStore,
  SessionQueueService,
} from '../../../../src/lib/index.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';

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
    clock: { now: () => new Date(Date.UTC(2026, 9, 30, 13, 0, seconds++)).toISOString() },
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
    should(store.logs.get(ID)).have.length(1);
    should(await service.list(ID)).deepEqual([message]);
  });

  it('should answer a retried request from the first message, writing nothing', async () => {
    const { store, service } = subject();
    const first = await service.enqueue(ID, { id: 'm1', sender: 'human', text: 'ship it' });

    const second = await service.enqueue(ID, { id: 'm1', sender: 'human', text: 'ship it' });

    should(second).deepEqual({ message: first.message, created: false });
    should(first.message).not.have.property('from');
    should(first.message.attachmentIds).eql([]);
    should(store.logs.get(ID)).have.length(1);
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
    should(await service.list(ID)).deepEqual([cancelled]);
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
