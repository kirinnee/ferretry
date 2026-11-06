import { describe, it } from 'bun:test';
import { QUEUE_CHANGED_EVENT, type QueueChangedEventData } from '@ferretry/protocol';
import should from 'should';
import {
  NotifyingSessionQueueStore,
  type QueueChangePublisher,
  type QueueEvent,
  SessionQueueService,
  type SessionQueueStore,
} from '../../../../src/lib/index.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';

const ID = parseSessionId('session-1');
const AT = '2026-10-30T13:05:37.000Z';

/** The durable log as a list per session. */
class MemoryQueueStore implements SessionQueueStore {
  readonly logs = new Map<string, QueueEvent[]>();
  async read(id: SessionId): Promise<readonly QueueEvent[]> {
    return [...(this.logs.get(id) ?? [])];
  }
  async append(id: SessionId, event: QueueEvent): Promise<void> {
    this.logs.set(id, [...(this.logs.get(id) ?? []), event]);
  }
}

interface Announced {
  readonly id: SessionId;
  readonly type: string;
  readonly data: QueueChangedEventData;
  /** How many events the durable log held the moment this was announced. */
  readonly durable: number;
}

function subject(fail = false) {
  const inner = new MemoryQueueStore();
  const announced: Announced[] = [];
  const publisher: QueueChangePublisher = {
    publish: async (id, type, data) => {
      announced.push({ id, type, data, durable: inner.logs.get(id)?.length ?? 0 });
      if (fail) throw new Error('journal is down');
    },
  };
  const store = new NotifyingSessionQueueStore(inner, publisher);
  let seconds = 0;
  const service = new SessionQueueService({
    store,
    clock: { now: () => new Date(Date.UTC(2026, 9, 30, 13, 0, seconds++)).toISOString() },
    serial: { run: async (_key, work) => await work(), runExclusive: async work => await work() },
  });
  return { inner, store, service, announced };
}

describe('announcing a queue change', () => {
  it('should announce an enqueue, an edit and a cancel through the real service, each after it was durable', async () => {
    const { service, announced } = subject();

    await service.enqueue(ID, { id: 'm1', sender: 'human', text: 'secret words' });
    await service.edit(ID, 'm1', 'other secret words');
    await service.cancel(ID, 'm1');

    should(announced.map(each => each.data)).eql([
      { messageId: 'm1', change: 'enqueued' },
      { messageId: 'm1', change: 'edited' },
      { messageId: 'm1', change: 'moved' },
    ]);
    should(announced.every(each => each.type === QUEUE_CHANGED_EVENT && each.id === ID)).be.true();
    should(announced.map(each => each.durable)).eql([1, 2, 3]);
    should(JSON.stringify(announced)).not.containEql('secret');
  });

  it('should announce what a deliverer appends — a move and a waiting reason — through the same store', async () => {
    const { store, announced } = subject();

    await store.append(ID, { v: 1, kind: 'moved', at: AT, id: 'm1', state: 'typing' });
    await store.append(ID, { v: 1, kind: 'waiting', at: AT, id: 'm1', reason: 'busy' });

    should(announced.map(each => each.data)).eql([
      { messageId: 'm1', change: 'moved' },
      { messageId: 'm1', change: 'waiting' },
    ]);
  });

  it('should not announce a retried enqueue that wrote nothing, and a refused cancel', async () => {
    const { service, announced } = subject();
    await service.enqueue(ID, { id: 'm1', sender: 'human', text: 'hi' });
    await service.cancel(ID, 'm1');
    announced.length = 0;

    await service.enqueue(ID, { id: 'm1', sender: 'human', text: 'hi' });
    await service.cancel(ID, 'm1').catch(() => undefined);

    should(announced).be.empty();
  });

  it('should read the log through untouched', async () => {
    const { store, service } = subject();
    await service.enqueue(ID, { id: 'm1', sender: 'human', text: 'hi' });

    should(await store.read(ID)).have.length(1);
  });

  it('should never fail a change that is on disk because the announcement failed', async () => {
    const { service, inner, announced } = subject(true);

    const { message } = await service.enqueue(ID, { id: 'm1', sender: 'human', text: 'hi' });

    should(message.state).equal('queued');
    should(inner.logs.get(ID)).have.length(1);
    should(announced).have.length(1);
  });
});
