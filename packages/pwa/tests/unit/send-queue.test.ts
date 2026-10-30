import { describe, expect, test } from 'bun:test';
import type { QueuedMessage } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import type { OutboxEntry } from '../../src/lib/send-outbox.ts';
import {
  effectiveQueueState,
  joinOutbox,
  joinQueue,
  QueueActionError,
  queueActions,
  readSessionQueue,
} from '../../src/lib/send-queue.ts';

const message = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  v: 1,
  id: 'm1',
  sender: 'human',
  text: 'ship it',
  attachmentIds: [],
  enqueuedAt: '2026-10-30T10:00:00.000Z',
  state: 'queued',
  stateAt: '2026-10-30T10:00:00.000Z',
  revision: 1,
  ...overrides,
});

const row = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'm1',
  acceptedAt: '2026-10-30T10:00:01.000Z',
  message: 'ship it',
  attachmentIds: [],
  fate: 'accepted',
  ...overrides,
});

describe('joinQueue', () => {
  test('an unconfirmed queue message stays unaccounted on its ledger row, alone or joined, until proof arrives', () => {
    const unconfirmed = message({ state: 'unconfirmed' });
    const [alone] = joinQueue([], [unconfirmed]);
    const [joined] = joinQueue([row({ sendId: unconfirmed.id, fate: 'unaccounted' })], [unconfirmed]);
    const [proven] = joinQueue([row({ sendId: unconfirmed.id, fate: 'delivered' })], [unconfirmed]);

    expect(alone?.fate).toBe('unaccounted');
    expect(joined?.fate).toBe('unaccounted');
    expect(proven?.fate).toBe('delivered');
    expect(effectiveQueueState(proven as LedgerSendRecord)).toBe('delivered');
  });

  test('an empty queue returns the ledger untouched', () => {
    const rows = [row()];
    expect(joinQueue(rows, [])).toBe(rows);
  });

  test('a queue message with no ledger row becomes an open bubble of its own', () => {
    const [joined] = joinQueue(
      [],
      [
        message({
          sender: 'agent',
          from: 'sess-9',
          fromName: 'lead',
          replyExpected: true,
          waitReason: 'draft',
          attachmentIds: ['att_x'],
        }),
      ],
    );
    expect(joined).toEqual({
      sendId: 'm1',
      acceptedAt: '2026-10-30T10:00:00.000Z',
      message: 'ship it',
      attachmentIds: ['att_x'],
      fate: 'accepted',
      senderKind: 'agent',
      from: 'sess-9',
      fromName: 'lead',
      replyExpected: true,
      queue: { state: 'queued', stateAt: '2026-10-30T10:00:00.000Z', revision: 1, waitReason: 'draft' },
    });
  });

  test('queue-only rows follow the queue state: typing is open, cancelled and failed are settled, arrived is delivered', () => {
    const fates = (['queued', 'typing', 'delivered', 'read', 'cancelled', 'failed'] as const).map(state => {
      const [joined] = joinQueue([], [message({ state, stateAt: '2026-10-30T10:05:00.000Z' })]);
      return [state, joined?.fate, joined?.fateAt];
    });
    expect(fates).toEqual([
      ['queued', 'accepted', undefined],
      ['typing', 'accepted', undefined],
      ['delivered', 'delivered', '2026-10-30T10:05:00.000Z'],
      ['read', 'delivered', '2026-10-30T10:05:00.000Z'],
      ['cancelled', 'cancelled', '2026-10-30T10:05:00.000Z'],
      ['failed', 'timed_out', '2026-10-30T10:05:00.000Z'],
    ]);
    expect(joinQueue([], [message({ state: 'failed', failure: 'no pane' })])[0]?.queue?.failure).toBe('no pane');
  });

  test('a ledger row wears the queue view of the same id and keeps its own words', () => {
    const [joined] = joinQueue([row({ fate: 'queued', message: 'ledger words' })], [message({ state: 'typing' })]);
    expect(joined?.message).toBe('ledger words');
    expect(joined?.fate).toBe('queued');
    expect(joined?.queue?.state).toBe('typing');
  });

  test('a queue state of delivered or read wins over any ledger fate, and drops what contradicts it', () => {
    const unread = { since: 'x', reason: 'y' };
    for (const state of ['delivered', 'read'] as const)
      for (const fate of ['accepted', 'queued', 'timed_out', 'unaccounted', 'cancelled'] as const) {
        const [joined] = joinQueue(
          [row({ fate, unread, held: true, typedNotSent: true, retryable: true, fateAt: 'old' })],
          [message({ state, stateAt: '2026-10-30T10:09:00.000Z' })],
        );
        expect(joined?.fate).toBe('delivered');
        expect(joined?.fateAt).toBe('2026-10-30T10:09:00.000Z');
        expect(joined?.unread).toBeUndefined();
        expect(joined?.held).toBeUndefined();
        expect(joined?.typedNotSent).toBeUndefined();
        expect(joined?.retryable).toBeUndefined();
      }
  });

  test('a delivered ledger row is ahead of a queue that has not caught up and keeps its own time', () => {
    for (const state of ['queued', 'typing', 'cancelled', 'failed'] as const) {
      const [joined] = joinQueue([row({ fate: 'delivered', fateAt: 'ledger-time' })], [message({ state })]);
      expect(joined?.fate).toBe('delivered');
      expect(joined?.fateAt).toBe('ledger-time');
    }
    expect(joinQueue([row({ fate: 'delivered' })], [message({ state: 'typing', stateAt: 'q-time' })])[0]?.fateAt).toBe(
      'q-time',
    );
  });

  test('a person’s own ledger cancel stays cancelled', () => {
    expect(joinQueue([row({ fate: 'cancelled' })], [message({ state: 'typing' })])[0]?.fate).toBe('cancelled');
  });

  test('the queue gives up on a message the ledger had unsettled: failed and cancelled replace the fate', () => {
    expect(joinQueue([row({ fate: 'timed_out' })], [message({ state: 'failed' })])[0]?.fate).toBe('timed_out');
    expect(joinQueue([row()], [message({ state: 'cancelled', stateAt: 'c' })])[0]).toMatchObject({
      fate: 'cancelled',
      fateAt: 'c',
    });
  });

  test('a queue failure over an unaccounted ledger row stays unaccounted: it may have landed', () => {
    for (const fate of ['unaccounted', 'queued', 'accepted'] as const)
      expect(joinQueue([row({ fate })], [message({ state: 'failed' })])[0]?.fate).toBe('unaccounted');
  });

  test('a message still queued or typing is open again even if the ledger had timed out on an earlier try', () => {
    for (const fate of ['timed_out', 'unaccounted'] as const)
      expect(joinQueue([row({ fate })], [message({ state: 'queued' })])[0]?.fate).toBe('accepted');
  });

  test('rows the queue never saw pass through, and the queue-only ones follow them', () => {
    const other = row({ sendId: 'other' });
    const joined = joinQueue([other], [message({ id: 'fresh' })]);
    expect(joined.map(r => r.sendId)).toEqual(['other', 'fresh']);
    expect(joined[0]).toBe(other);
  });
});

describe('effectiveQueueState', () => {
  test('is the queue’s state, lifted to delivered when the ledger already says so', () => {
    const view = (state: QueuedMessage['state']) => ({ state, stateAt: 's', revision: 1 });
    expect(effectiveQueueState(row())).toBeUndefined();
    expect(effectiveQueueState(row({ queue: view('queued') }))).toBe('queued');
    expect(effectiveQueueState(row({ fate: 'delivered', queue: view('typing') }))).toBe('delivered');
    expect(effectiveQueueState(row({ fate: 'delivered', queue: view('read') }))).toBe('read');
  });
});

const failing = (status: number) => ({
  request: async () => {
    throw new FyHttpError('nope', status, undefined);
  },
});

describe('readSessionQueue', () => {
  test('reads and parses the messages from the session’s queue route', async () => {
    const seen: string[] = [];
    const api = {
      request: async (path: string) => {
        seen.push(path);
        return { messages: [message()] };
      },
    };
    expect(await readSessionQueue(api as never, 'a/b')).toEqual([message()]);
    expect(seen).toEqual(['/v1/sessions/a%2Fb/queue']);
  });

  test('an older daemon with no queue route (404 or 405) is no queue, not an error', async () => {
    expect(await readSessionQueue(failing(404) as never, 's')).toEqual([]);
    expect(await readSessionQueue(failing(405) as never, 's')).toEqual([]);
  });

  test('a page this build cannot read is no queue; any other failure is the caller’s to report', async () => {
    expect(await readSessionQueue({ request: async () => ({ messages: [{ id: 1 }] }) } as never, 's')).toEqual([]);
    expect(readSessionQueue(failing(500) as never, 's')).rejects.toThrow('nope');
    expect(
      readSessionQueue({ request: async () => Promise.reject(new Error('offline')) } as never, 's'),
    ).rejects.toThrow('offline');
  });
});

describe('queueActions', () => {
  const recorder = (status?: number) => {
    const calls: { path: string; init: RequestInit | undefined }[] = [];
    const client = {
      request: async (path: string, _schema: unknown, init?: RequestInit) => {
        calls.push({ path, init });
        if (status !== undefined) throw new FyHttpError('server words', status, undefined);
        return message();
      },
    };
    return { client, calls };
  };

  test('edit PATCHes the new words, cancel DELETEs, and each asks for a refresh', async () => {
    const { client, calls } = recorder();
    let refreshes = 0;
    const actions = queueActions(client as never, 's/1', () => {
      refreshes += 1;
    });
    expect(await actions.edit({ sendId: 'm 1' }, '  new words ')).toBe(true);
    expect(await actions.cancel({ sendId: 'm 1' })).toBe(true);
    expect(calls[0]?.path).toBe('/v1/sessions/s%2F1/queue/m%201');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: 'new words' });
    expect(calls[1]?.init?.method).toBe('DELETE');
    expect(refreshes).toBe(2);
  });

  test('a 409 says it was just typed, a 404 says the queue lost it, and both still refresh the stale row', async () => {
    for (const [status, kind, words] of [
      [409, 'typed', 'just typed'],
      [404, 'unknown', 'no longer has'],
    ] as const) {
      const { client } = recorder(status);
      let refreshes = 0;
      const actions = queueActions(client as never, 's', () => {
        refreshes += 1;
      });
      const error = await actions.cancel({ sendId: 'm1' }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(QueueActionError);
      expect((error as QueueActionError).kind).toBe(kind);
      expect((error as QueueActionError).message).toContain(words);
      const edited = await actions.edit({ sendId: 'm1' }, 'x').catch((reason: unknown) => reason);
      expect((edited as QueueActionError).kind).toBe(kind);
      expect(refreshes).toBe(2);
    }
  });

  test('any other failure is passed on as it came, and no client answers false', async () => {
    const { client } = recorder(500);
    const actions = queueActions(client as never, 's', () => undefined);
    expect(actions.cancel({ sendId: 'm1' })).rejects.toThrow('server words');
    const none = queueActions(null, 's', () => undefined);
    expect(await none.edit({ sendId: 'm1' }, 'x')).toBe(false);
    expect(await none.cancel({ sendId: 'm1' })).toBe(false);
  });
});

describe('joinOutbox', () => {
  const entry = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
    id: 'o1',
    daemonId: 'd1',
    sessionId: 's1',
    message: 'thank you',
    attachmentIds: ['a'],
    files: [],
    now: false,
    createdAt: '2026-10-30T10:00:05.000Z',
    seq: 1,
    ...overrides,
  });

  test('nothing waiting leaves the rows as they were', () => {
    const rows = [row()];
    expect(joinOutbox(rows, [])).toBe(rows);
  });

  test('a message the machine already knows is shown once, as the machine says it', () => {
    const rows = [row({ sendId: 'o1' })];
    expect(joinOutbox(rows, [entry()])).toBe(rows);
  });

  test('a message only on this device becomes a queued bubble marked as the first tick, with its place', () => {
    const joined = joinOutbox([row()], [entry(), entry({ id: 'o2', reason: 'x', refused: true })]);
    expect(joined.map(item => item.sendId)).toEqual(['m1', 'o1', 'o2']);
    expect(joined[1]).toMatchObject({
      fate: 'accepted',
      senderKind: 'human',
      attachmentIds: ['a'],
      queue: { state: 'queued', revision: 0 },
      outbox: { reason: 'waiting for connection', position: 1, of: 2 },
    });
    expect(joined[2]?.outbox).toEqual({ reason: 'x', refused: true, position: 2, of: 2 });
  });
});

describe('queueActions with an outbox', () => {
  const record = { sendId: 'o1' };
  test('edit and cancel change a message still on this device and never ask the machine', async () => {
    const calls: string[] = [];
    const refreshed: number[] = [];
    const outbox = {
      edit: async (id: string, text: string) => {
        calls.push(`edit ${id} ${text}`);
        return 'edited' as const;
      },
      cancel: async (id: string) => {
        calls.push(`cancel ${id}`);
        return 'cancelled' as const;
      },
    };
    const client = {
      request: async () => {
        throw new Error('the machine must not be asked');
      },
    };
    const actions = queueActions(client as never, 's', () => refreshed.push(1), outbox);
    expect(await actions.edit(record, 'thank you!')).toBe(true);
    expect(await actions.cancel(record)).toBe(true);
    expect(calls).toEqual(['edit o1 thank you!', 'cancel o1']);
    expect(refreshed).toHaveLength(2);
  });

  test('a message that has left goes to the machine’s queue, and with no client it is not changed', async () => {
    const outbox = {
      edit: async () => 'elsewhere' as const,
      cancel: async () => 'elsewhere' as const,
    };
    const seen: string[] = [];
    const client = {
      request: async (path: string, _schema: unknown, init: RequestInit) => {
        seen.push(`${init.method} ${path}`);
        return {};
      },
    };
    const actions = queueActions(client as never, 's', () => undefined, outbox);
    expect(await actions.edit(record, 'x')).toBe(true);
    expect(await actions.cancel(record)).toBe(true);
    expect(seen).toEqual(['PATCH /v1/sessions/s/queue/o1', 'DELETE /v1/sessions/s/queue/o1']);
    const offline = queueActions(null, 's', () => undefined, outbox);
    expect(await offline.edit(record, 'x')).toBe(false);
    expect(await offline.cancel(record)).toBe(false);
  });
});
