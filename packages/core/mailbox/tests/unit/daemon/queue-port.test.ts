import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { Instant } from '@ferretry/std';
import {
  foldQueue,
  type MailboxHost,
  type MailboxQueueApi,
  QueueChanged,
  type QueueEvent,
  type QueuedMessage,
  type SessionQueueStore,
} from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';

const F1 = ferretId('f1');
const AT = '2026-11-08T09:00:00Z' as Instant;

/** The log a queue store keeps, in memory; a failing store stands for a disk that breaks. */
class MemoryStore implements SessionQueueStore {
  readonly logs = new Map<string, QueueEvent[]>();
  failing = false;

  async messages(id: FerretId): Promise<readonly QueuedMessage[]> {
    if (this.failing) throw new Error('FIXTURE_SECRET the disk is gone');
    return foldQueue(this.logs.get(id) ?? []);
  }

  async append(id: FerretId, event: QueueEvent): Promise<void> {
    this.logs.set(id, [...(this.logs.get(id) ?? []), event]);
  }
}

const waiting = (id: string, state: QueuedMessage['state'] = 'queued'): QueueEvent => ({
  v: 1,
  kind: 'enqueued',
  at: AT,
  message: {
    v: 1,
    id,
    sender: 'human',
    text: 'wait',
    attachmentIds: [],
    enqueuedAt: AT,
    state,
    stateAt: AT,
    revision: 1,
  },
});

/** The Mailbox's daemon half, over a queue store Conversation would have provided and an event log that remembers. */
function mailbox(provided: 'filled' | 'unavailable' = 'filled') {
  const store = new MemoryStore();
  const published: { event: unknown; payload: unknown }[] = [];
  if (daemon.build === undefined) throw new Error('the Mailbox daemon has no build');
  const host: MailboxHost = { queue: store, ledger: {} as MailboxHost['ledger'] };
  const built = daemon.build({
    hooks: { provider: () => (provided === 'filled' ? host : 'unavailable') },
    kernel: {
      clock: { now: () => AT },
      events: { publish: async (event: unknown, payload: unknown) => void published.push({ event, payload }) },
      log: { error: () => undefined },
    },
  } as never) as unknown as { provides: { mailbox: MailboxQueueApi } };
  return { store, published, port: built.provides.mailbox };
}

describe('the Mailbox queue port', () => {
  test('lists, edits and takes back a waiting message, announcing each change once', async () => {
    const { store, published, port } = mailbox();
    await store.append(F1, waiting('q-1'));
    await store.append(F1, waiting('q-2'));

    expect((await port.queue(F1)).messages.map(message => message.id)).toEqual(['q-1', 'q-2']);
    expect(await port.editQueued(F1, 'q-1', { text: 'new words' })).toMatchObject({
      ok: true,
      value: { id: 'q-1', text: 'new words', revision: 2 },
    });
    expect(await port.cancelQueued(F1, 'q-2')).toMatchObject({ ok: true, value: { id: 'q-2', state: 'cancelled' } });
    expect(published.map(entry => entry.event)).toEqual([QueueChanged, QueueChanged]);
    expect(published.map(entry => (entry.payload as { message: string }).message)).toEqual(['q-1', 'q-2']);
  });

  test('a message that is not there, or no longer waits, is refused with the reason a caller can branch on', async () => {
    const { store, published, port } = mailbox();
    await store.append(F1, waiting('q-typing', 'typing'));

    expect(await port.editQueued(F1, 'q-none', { text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await port.editQueued(F1, 'q-typing', { text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'not_waiting' },
    });
    expect(await port.cancelQueued(F1, 'q-typing')).toMatchObject({ ok: false, error: { code: 'not_waiting' } });
    expect(published).toEqual([]);
  });

  test('a store that fails with something nobody worded is not made into a refusal', async () => {
    const { store, port } = mailbox();
    await store.append(F1, waiting('q-1'));
    store.failing = true;

    await expect(port.editQueued(F1, 'q-1', { text: 'x' })).rejects.toThrow('FIXTURE_SECRET');
    await expect(port.cancelQueued(F1, 'q-1')).rejects.toThrow('FIXTURE_SECRET');
  });

  test('with nothing in the mailbox.host slot every use refuses, never an empty queue', async () => {
    const { port } = mailbox('unavailable');
    await expect(port.queue(F1)).rejects.toThrow();
  });
});
