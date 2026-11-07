import { describe, expect, test } from 'bun:test';
import type { QueuedMessage } from '../../../../contract/index.ts';
import { DaemonCallError } from '@ferretry/app';
import { type CallHandler, fakeClient } from '../../../support/app/fake-client.ts';
import type { LedgerSendRecord } from '../../../../app/chat/send-ledger.ts';
import type { OutboxEntry } from '../../../../app/composer/send-outbox.ts';
import {
  effectiveQueueState,
  joinOutbox,
  joinQueue,
  QueueActionError,
  extendQueueHistory,
  olderRequest,
  queueActions,
  readFerretQueue,
  readFerretQueuePage,
  refreshQueueHistory,
  startQueueHistory,
  withdrawQueued,
  withdrawReplyVia,
} from '../../../../app/queue/send-queue.ts';

const message = (overrides: Partial<Record<keyof QueuedMessage, unknown>> = {}): QueuedMessage =>
  ({
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
  }) as QueuedMessage;

const row = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'm1',
  acceptedAt: '2026-10-30T10:00:01.000Z',
  message: 'ship it',
  attachmentIds: [],
  fate: 'accepted',
  ...overrides,
});

describe('joinQueue', () => {
  describe('several messages delivered as one turn', () => {
    const at = '2026-10-30T10:00:05.000Z';
    const members = [
      message({
        id: 'm1',
        sender: 'agent',
        fromName: 'rhett',
        text: 'first',
        state: 'delivered',
        stateAt: at,
        deliveredAs: 'm1',
      }),
      message({
        id: 'm2',
        sender: 'agent',
        fromName: 'sada',
        text: 'second',
        state: 'delivered',
        stateAt: at,
        deliveredAs: 'm1',
        label: 'fyi',
      }),
      message({
        id: 'm3',
        sender: 'agent',
        fromName: 'rhett',
        text: 'third',
        state: 'delivered',
        stateAt: at,
        deliveredAs: 'm1',
      }),
    ];
    const combined = '[3 messages from ferrets, oldest first — not from the owner]\n\n…';
    const lead = row({ sendId: 'm1', message: combined, fate: 'delivered' });

    test('the combined ledger row joins its lead alone; the other members keep rows of their own words', () => {
      const rows = joinQueue([lead], members);

      expect(rows.map(r => [r.sendId, r.message])).toEqual([
        ['m1', combined],
        ['m2', 'second'],
        ['m3', 'third'],
      ]);
    });

    test('no member is swallowed or drawn twice, and each carries its own sender and ticks', () => {
      const rows = joinQueue([lead], members);

      expect(new Set(rows.map(r => r.sendId)).size).toBe(members.length);
      expect(rows.map(r => r.fromName)).toEqual([undefined, 'sada', 'rhett']);
      expect(rows.every(r => r.fate === 'delivered' && r.queue?.state === 'delivered')).toBe(true);
    });

    test('a member says which turn carried it; the lead does not point at itself', () => {
      const rows = joinQueue([lead], members);

      expect(rows.map(r => r.queue?.deliveredAs)).toEqual([undefined, 'm1', 'm1']);
    });
  });

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

const QUEUE = 'GET /v1/ferrets/:ferretId/queue';
const PATCH = 'PATCH /v1/ferrets/:ferretId/queue/:messageId';
const DELETE = 'DELETE /v1/ferrets/:ferretId/queue/:messageId';

/** A client every queue route of which refuses with `status`, as the daemon would. */
const failing = (status: number) => {
  const refuse: CallHandler = () => {
    throw new DaemonCallError(status, 'refused', 'server words');
  };
  return fakeClient({ [QUEUE]: refuse, [PATCH]: refuse, [DELETE]: refuse });
};

describe('readFerretQueue', () => {
  test('reads and parses the messages from the ferret’s queue route', async () => {
    const client = fakeClient({ [QUEUE]: () => ({ messages: [message()] }) });
    expect(await readFerretQueue(client, 'a-b')).toEqual([message()]);
    expect(client.calls).toMatchObject([{ route: QUEUE, params: { ferretId: 'a-b' }, query: {} }]);
  });

  test('a failure, or a page this build cannot read, is the caller’s to report', async () => {
    expect(readFerretQueue(failing(500), 's')).rejects.toThrow('server words');
    expect(readFerretQueue(fakeClient({ [QUEUE]: () => ({ messages: [{ id: 1 }] }) }), 's')).rejects.toThrow();
  });
});

describe('readFerretQueuePage', () => {
  test('asks the window with no parameters, and reads a daemon that names no cursor as having nothing older', async () => {
    const client = fakeClient({ [QUEUE]: () => ({ messages: [message()] }) });
    expect(await readFerretQueuePage(client, 's')).toEqual({ messages: [message()], nextCursor: null });
    expect(client.calls[0]?.query).toEqual({});
  });

  test('asks the next older page by its cursor and limit', async () => {
    const client = fakeClient({ [QUEUE]: () => ({ messages: [], nextCursor: 'm9' }) });
    expect(await readFerretQueuePage(client, 's', { before: 'm 1', limit: 50 })).toEqual({
      messages: [],
      nextCursor: 'm9',
    });
    expect(client.calls[0]?.query).toEqual({ before: 'm 1', limit: '50' });
  });
});

describe('a queue window against its ledger', () => {
  test('a bubble whose queue row fell outside the window is drawn from its ledger row alone', () => {
    const old = row({ sendId: 'old', message: 'from long ago', fate: 'delivered' });
    const recent = row({ sendId: 'new', message: 'recent' });

    const joined = joinQueue([old, recent], [message({ id: 'new', state: 'typing' })]);

    expect(joined.find(each => each.sendId === 'old')).toEqual(old);
    expect(joined.find(each => each.sendId === 'new')?.queue?.state).toBe('typing');
    expect(joined).toHaveLength(2);
  });

  test('a window with no queue rows leaves every ledger row as it was', () => {
    const rows = [row({ sendId: 'a' }), row({ sendId: 'b', fate: 'delivered' })];
    expect(joinQueue(rows, [])).toBe(rows);
  });
});

describe('the queue history a page holds', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 30, 10, minute)).toISOString();
  const read = (id: string, minute: number) => message({ id, enqueuedAt: at(minute), state: 'read' });
  const waiting = (id: string, minute: number) => message({ id, enqueuedAt: at(minute), state: 'queued' });
  const ids = (history: { readonly messages: readonly QueuedMessage[] }) => history.messages.map(each => each.id);

  test('is the window until older messages are asked for, and each poll replaces it', () => {
    const first = startQueueHistory({ messages: [read('b', 2), read('c', 3)], nextCursor: 'b' });
    const next = refreshQueueHistory(first, { messages: [read('c', 3), read('d', 4)], nextCursor: 'c' });

    expect(ids(next)).toEqual(['c', 'd']);
    expect(next).toMatchObject({ cursor: 'c', older: false });
  });

  test('adds an older page once, oldest first, and moves the cursor on', () => {
    const first = startQueueHistory({ messages: [read('c', 3), read('d', 4)], nextCursor: 'c' });

    const extended = extendQueueHistory(first, {
      messages: [read('a', 1), read('b', 2), read('c', 3)],
      nextCursor: null,
    });

    expect(ids(extended)).toEqual(['a', 'b', 'c', 'd']);
    expect(extended).toMatchObject({ cursor: null, older: true });
  });

  test('keeps the older messages shown when a poll pushes the window’s edge up', () => {
    const first = startQueueHistory({ messages: [read('c', 3), read('d', 4)], nextCursor: 'c' });
    const extended = extendQueueHistory(first, { messages: [read('a', 1), read('b', 2)], nextCursor: null });

    // A new message arrived: the window now spans d, e and c fell off it.
    const polled = refreshQueueHistory(extended, { messages: [read('d', 4), read('e', 5)], nextCursor: 'd' });

    expect(ids(polled)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(polled.cursor).toBeNull();
  });

  test('lets a fresh read win for a message it carries', () => {
    const first = startQueueHistory({ messages: [waiting('c', 3)], nextCursor: 'c' });
    const extended = extendQueueHistory(first, { messages: [read('a', 1)], nextCursor: null });

    const polled = refreshQueueHistory(extended, { messages: [read('c', 3)], nextCursor: 'c' });

    expect(polled.messages.find(each => each.id === 'c')?.state).toBe('read');
  });

  test('holds a message that moved mid-walk once, in its newest state, when an older page repeats it', () => {
    // The reviewer's timeline: a (old, queued), b and c read; the window is [a, c] with cursor c.
    const first = startQueueHistory({ messages: [waiting('a', 1), read('c', 3)], nextCursor: 'c' });
    const cancelledAt = '2026-10-30T11:00:00.000Z';

    // a is cancelled, then the older page [a (cancelled), b] arrives.
    const extended = extendQueueHistory(first, {
      messages: [message({ id: 'a', enqueuedAt: at(1), state: 'cancelled', stateAt: cancelledAt }), read('b', 2)],
      nextCursor: null,
    });

    expect(ids(extended)).toEqual(['a', 'b', 'c']);
    expect(extended.messages.find(each => each.id === 'a')?.state).toBe('cancelled');
  });

  test('never regresses a message to an older state or revision when a stale read repeats it', () => {
    const edited = message({
      id: 'a',
      enqueuedAt: at(1),
      revision: 2,
      text: 'edited words',
      stateAt: '2026-10-30T10:05:00.000Z',
    });
    const first = startQueueHistory({ messages: [edited], nextCursor: 'a' });

    const extended = extendQueueHistory(first, {
      messages: [message({ id: 'a', enqueuedAt: at(1), revision: 1 })],
      nextCursor: null,
    });
    const moved = extendQueueHistory(
      startQueueHistory({
        messages: [message({ id: 'z', enqueuedAt: at(9), state: 'read', stateAt: '2026-10-30T10:30:00.000Z' })],
        nextCursor: 'z',
      }),
      {
        messages: [message({ id: 'z', enqueuedAt: at(9), state: 'queued', stateAt: '2026-10-30T10:00:00.000Z' })],
        nextCursor: null,
      },
    );

    expect(extended.messages[0]).toMatchObject({ revision: 2, text: 'edited words' });
    expect(moved.messages[0]?.state).toBe('read');
  });

  test('restarts only the walk, keeping every other message, when a message held as waiting is no longer in the window', () => {
    const first = startQueueHistory({ messages: [read('d', 4), read('e', 5)], nextCursor: 'd' });
    const extended = extendQueueHistory(
      extendQueueHistory(first, { messages: [read('b', 2), read('c', 3)], nextCursor: 'b' }),
      { messages: [waiting('a', 1)], nextCursor: null },
    );

    // `a` finished since (cancelled, say), so the window carries it no more and its new state is unknown: it is let go
    // and the walk starts again from the window's edge, but what else was loaded stays on screen.
    const polled = refreshQueueHistory(extended, { messages: [read('d', 4), read('e', 5)], nextCursor: 'd' });

    expect(ids(polled)).toEqual(['b', 'c', 'd', 'e']);
    expect(polled).toMatchObject({ cursor: 'd', older: true, walk: extended.walk + 1 });
  });

  test('keeps the walk, and its number, while every open message held is still in the window', () => {
    const first = startQueueHistory({ messages: [waiting('c', 3)], nextCursor: 'c' });
    const extended = extendQueueHistory(first, { messages: [read('a', 1)], nextCursor: null });

    const polled = refreshQueueHistory(extended, { messages: [waiting('c', 3)], nextCursor: 'c' });

    expect(polled).toMatchObject({ cursor: null, older: true, walk: extended.walk });
  });

  test('keeps the walk number when a poll replaces a window nothing older was asked of', () => {
    const first = startQueueHistory({ messages: [read('c', 3)], nextCursor: 'c' });

    expect(refreshQueueHistory(first, { messages: [read('d', 4)], nextCursor: 'd' }).walk).toBe(first.walk);
    expect(refreshQueueHistory(undefined, { messages: [], nextCursor: null }).walk).toBe(0);
  });

  test('does not merge an older page asked for a walk or cursor the history has left', () => {
    const first = startQueueHistory({ messages: [read('d', 4)], nextCursor: 'd' });
    const page = { messages: [read('c', 3)], nextCursor: null };

    const asked = olderRequest(first);
    expect(asked).toEqual({ walk: 0, cursor: 'd' });
    expect(extendQueueHistory(first, page, asked)).toMatchObject({ cursor: null, older: true });
    expect(extendQueueHistory(first, page, { walk: 1, cursor: 'd' })).toBe(first);
    expect(extendQueueHistory(first, page, { walk: 0, cursor: 'x' })).toBe(first);
    expect(olderRequest({ ...first, cursor: null })).toBeUndefined();
  });
});

describe('which look at a message is the later one', () => {
  const stamped = (overrides: Partial<Record<keyof QueuedMessage, unknown>>) =>
    message({ id: 'a', enqueuedAt: '2026-10-30T10:00:00.000Z', stateAt: '2026-10-30T11:00:00.000Z', ...overrides });
  const held = (...messages: QueuedMessage[]) => startQueueHistory({ messages, nextCursor: 'a' });
  const merged = (from: QueuedMessage, incoming: QueuedMessage) =>
    extendQueueHistory(held(from), { messages: [incoming], nextCursor: null }).messages[0];

  test('is decided by the version when both carry one, whatever the clock and the state say', () => {
    const early = stamped({ state: 'unconfirmed', version: 5 });
    const late = stamped({ state: 'read', version: 6 });

    expect(merged(early, late)?.state).toBe('read');
    expect(merged(late, early)?.state).toBe('read');
    expect(merged(late, { ...late, text: 'same fact' })?.text).not.toBe('same fact');
  });

  test('never lets a stale snapshot that shares the millisecond undo a state read after it, without a version', () => {
    const unconfirmed = stamped({ state: 'unconfirmed' });
    const done = stamped({ state: 'read' });

    expect(merged(done, unconfirmed)?.state).toBe('read');
    expect(merged(unconfirmed, done)?.state).toBe('read');
    expect(merged(stamped({ state: 'typing' }), stamped({ state: 'delivered' }))?.state).toBe('delivered');
    expect(merged(stamped({ state: 'delivered' }), stamped({ state: 'typing' }))?.state).toBe('delivered');
  });

  test('takes the incoming look at a message equally far along, the newer look at the same state', () => {
    expect(merged(stamped({ state: 'queued' }), stamped({ state: 'queued', waitReason: 'busy' }))?.waitReason).toBe(
      'busy',
    );
  });

  test('falls back to revision and instant when only one look carries a version', () => {
    const versioned = stamped({ state: 'read', version: 9 });
    const old = stamped({ state: 'delivered', stateAt: '2026-10-30T12:00:00.000Z' });

    expect(merged(versioned, old)?.state).toBe('delivered');
  });

  test('a window that lacks the unconfirmed-to-read merge cannot undo it in the same millisecond', () => {
    // The reviewer's timeline: a typed → unconfirmed → read inside one tick; an older page repeats it as read and is
    // merged; then a window captured while it was only unconfirmed lands.
    const typing = stamped({ state: 'typing', stateAt: '2026-10-30T10:00:00.000Z' });
    const history = startQueueHistory({ messages: [typing, read('c', 3)], nextCursor: 'c' });
    const afterOlder = extendQueueHistory(history, {
      messages: [stamped({ state: 'read' }), read('b', 2)],
      nextCursor: null,
    });

    const result = refreshQueueHistory(afterOlder, {
      messages: [stamped({ state: 'unconfirmed' }), read('c', 3)],
      nextCursor: 'c',
    });

    expect(result.messages.find(each => each.id === 'a')?.state).toBe('read');
    expect(result.walk).toBe(afterOlder.walk);
    expect(ids(result)).toEqual(['a', 'b', 'c']);
  });

  const ids = (history: { readonly messages: readonly QueuedMessage[] }) => history.messages.map(each => each.id);
  const read = (id: string, minute: number) =>
    message({ id, enqueuedAt: new Date(Date.UTC(2026, 9, 30, 10, minute)).toISOString(), state: 'read' });
});

describe('queueActions', () => {
  const recorder = (status?: number) => {
    const record: CallHandler = () => {
      if (status !== undefined) throw new DaemonCallError(status, 'refused', 'server words');
      return message();
    };
    const client = fakeClient({ [PATCH]: record, [DELETE]: record });
    return { client, calls: client.calls };
  };

  test('edit PATCHes the new words, cancel DELETEs, and each asks for a refresh', async () => {
    const { client, calls } = recorder();
    let refreshes = 0;
    const actions = queueActions(client, 's-1', () => {
      refreshes += 1;
    });
    expect(await actions.edit({ sendId: 'm 1' }, '  new words ')).toBe(true);
    expect(await actions.cancel({ sendId: 'm 1' })).toBe(true);
    expect(calls[0]).toMatchObject({
      route: PATCH,
      params: { ferretId: 's-1', messageId: 'm 1' },
      body: { text: 'new words' },
    });
    expect(calls[1]).toMatchObject({ route: DELETE, params: { ferretId: 's-1', messageId: 'm 1' } });
    expect(refreshes).toBe(2);
  });

  test('a 409 says it was just typed, a 404 says the queue lost it, and both still refresh the stale row', async () => {
    for (const [status, kind, words] of [
      [409, 'typed', 'just typed'],
      [404, 'unknown', 'no longer has'],
    ] as const) {
      const { client } = recorder(status);
      let refreshes = 0;
      const actions = queueActions(client, 's', () => {
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
    const actions = queueActions(client, 's', () => undefined);
    expect(actions.cancel({ sendId: 'm1' })).rejects.toThrow('server words');
    const none = queueActions(null, 's', () => undefined);
    expect(await none.edit({ sendId: 'm1' }, 'x')).toBe(false);
    expect(await none.cancel({ sendId: 'm1' })).toBe(false);
  });
});

describe('joinOutbox', () => {
  const entry = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
    format: 1,
    id: 'o1',
    daemonId: 'd1',
    ferretId: 's1',
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

  test('files still to upload are named on the bubble, and a message with none names nothing', () => {
    const photo = { name: 'site-photo.png', type: 'image/png', blob: new Blob([]) };
    const joined = joinOutbox([], [entry({ files: [photo] }), entry({ id: 'o2' })]);
    expect(joined[0]?.outbox?.files).toEqual(['site-photo.png']);
    expect(joined[1]?.outbox).not.toHaveProperty('files');
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
    const client = fakeClient({});
    const actions = queueActions(client, 's', () => refreshed.push(1), outbox);
    expect(await actions.edit(record, 'thank you!')).toBe(true);
    expect(await actions.cancel(record)).toBe(true);
    expect(calls).toEqual(['edit o1 thank you!', 'cancel o1']);
    expect(client.calls).toEqual([]);
    expect(refreshed).toHaveLength(2);
  });

  test('a message that has left goes to the machine’s queue, and with no client it is not changed', async () => {
    const outbox = {
      edit: async () => 'elsewhere' as const,
      cancel: async () => 'elsewhere' as const,
    };
    const client = fakeClient({ [PATCH]: () => message(), [DELETE]: () => message() });
    const actions = queueActions(client, 's', () => undefined, outbox);
    expect(await actions.edit(record, 'x')).toBe(true);
    expect(await actions.cancel(record)).toBe(true);
    expect(client.calls.map(call => `${call.route} ${call.params?.['messageId']}`)).toEqual([
      `${PATCH} o1`,
      `${DELETE} o1`,
    ]);
    const offline = queueActions(null, 's', () => undefined, outbox);
    expect(await offline.edit(record, 'x')).toBe(false);
    expect(await offline.cancel(record)).toBe(false);
  });
});

describe('withdrawQueued', () => {
  test('a message still waiting on the machine is taken back through the queue route', async () => {
    const client = fakeClient({ [DELETE]: () => message() });
    expect(await withdrawQueued(client, 's-1', 'm1')).toBe('withdrawn');
    expect(client.calls).toMatchObject([{ route: DELETE, params: { ferretId: 's-1', messageId: 'm1' } }]);
  });

  test('a message still on this device is cancelled there, without a request', async () => {
    const client = fakeClient({});
    const outbox = { edit: async () => 'gone' as const, cancel: async () => 'cancelled' as const };
    expect(await withdrawQueued(client, 's', 'o1', outbox as never)).toBe('withdrawn');
    expect(client.calls).toEqual([]);
  });

  test('the agent already typing it (409) or the queue not knowing it (404) is `taken`, not a failure', async () => {
    expect(await withdrawQueued(failing(409), 's', 'm1')).toBe('taken');
    expect(await withdrawQueued(failing(404), 's', 'm1')).toBe('taken');
  });

  test('any other refusal, or no way to reach the machine, throws so Undo can say the reply may still arrive', async () => {
    expect(withdrawQueued(failing(500), 's', 'm1')).rejects.toThrow('server words');
    expect(withdrawQueued(null, 's', 'm1')).rejects.toThrow('not reachable');
  });
});

describe('withdrawReplyVia', () => {
  const card = { daemon: 'studio', ferret: 's1' };

  test('takes the reply back from the machine it went to, through that machine’s client', async () => {
    const asked: string[] = [];
    const studio = fakeClient({ [DELETE]: () => message() });
    const outbox = { edit: async () => 'gone' as const, cancel: async () => 'gone' as const };
    const take = withdrawReplyVia(daemon => {
      asked.push(daemon);
      return daemon === 'studio' ? studio : undefined;
    }, outbox as never);
    expect(await take(card, 'm1')).toBe('withdrawn');
    expect(asked).toEqual(['studio']);
    expect(studio.calls).toMatchObject([{ route: DELETE, params: { ferretId: 's1', messageId: 'm1' } }]);
  });

  test('refuses a machine that is no longer paired, without asking anyone', async () => {
    const take = withdrawReplyVia(() => undefined, {} as never);
    expect(take({ daemon: 'laptop', ferret: 's1' }, 'm1')).rejects.toThrow('no longer paired');
  });
});
