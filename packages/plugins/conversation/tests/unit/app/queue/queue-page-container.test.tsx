import { afterEach, describe, expect, test } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import { ensureDom, RouterProvider, render, runAsync, settleUntil } from '@ferretry/app/testing';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { MemoryOutboxBackend } from '../../../../app/composer/send-outbox.ts';
import {
  createDaemonOutbox,
  type DaemonOutbox,
  SendOutboxProvider,
} from '../../../../app/composer/send-outbox-wiring.ts';
import { QueuePanel } from '../../../../app/queue/queue-page.tsx';
import { type FakeClient, fakeClient, type RecordedCall, withClient } from '../../../support/app/client.tsx';

ensureDom();

const QUEUE = 'GET /v1/ferrets/:ferretId/queue';
const FERRET = 'GET /v1/ferrets/:ferretId';
const EDIT = 'PATCH /v1/ferrets/:ferretId/queue/:messageId';
const CANCEL = 'DELETE /v1/ferrets/:ferretId/queue/:messageId';

let mounted: ReactTestRenderer | undefined;
let outboxes: DaemonOutbox[] = [];
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  for (const each of outboxes) each.stop();
  outboxes = [];
});

const text = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : text(child))).join('');
const page = (): string => JSON.stringify(mounted?.toJSON());

/** The daemon's answers by "path?query": a value, an Error to throw, or a promise the case resolves by hand. */
type Answers = Record<string, unknown>;

/** Where a call reads, spelled as today's suite spelled it: the queue path and its `before` cursor. */
const where = (call: RecordedCall): string => {
  const before = call.query.before;
  return `/v1/ferrets/${call.params.ferretId}/queue${before === undefined ? '' : `?before=${before}`}`;
};

const daemon = (answers: Answers, down = false): FakeClient =>
  fakeClient({
    [FERRET]: call => ({ id: call.params.ferretId, name: 'one', label: 'Casen' }),
    [QUEUE]: async call => {
      if (down) throw new DaemonCallError(503, 'unreachable', 'The daemon cannot be reached.');
      const answer = answers[where(call)];
      if (answer instanceof Error) throw answer;
      return (await answer) ?? { messages: [] };
    },
    [EDIT]: () => ({}),
    [CANCEL]: () => ({}),
  });

/** This device's outbox for `d1`: its machine cannot take a message, so what is in it waits. */
const deviceOutbox = (): DaemonOutbox => {
  const made = createDaemonOutbox({
    daemonId: 'd1',
    backend: new MemoryOutboxBackend(),
    environment: { onRecovered: () => () => undefined, onOnline: () => () => undefined },
  });
  outboxes.push(made);
  return made;
};

const unreachable = {
  send: async () => {
    throw new DaemonCallError(503, 'unreachable', 'The daemon cannot be reached.');
  },
  upload: async () => {
    throw new DaemonCallError(503, 'unreachable', 'The daemon cannot be reached.');
  },
};

const open = (client: FakeClient, outbox: DaemonOutbox = deviceOutbox()): void => {
  mounted = render(
    <RouterProvider>
      <SendOutboxProvider daemonId="d1" outbox={outbox} sender={unreachable}>
        {withClient(client, <QueuePanel subject="s1" />)}
      </SendOutboxProvider>
    </RouterProvider>,
  );
};

const queueReads = (client: FakeClient): string[] => client.callsTo(QUEUE).map(where);
const olderReads = (client: FakeClient): string[] => queueReads(client).filter(call => call.includes('before'));

const rowIds = (): string[] =>
  (
    mounted?.root.findAll(node => typeof node.type === 'string' && node.props['data-queue-row'] !== undefined) ?? []
  ).map(node => String(node.props['data-queue-row']));

const pressOlder = async (): Promise<void> =>
  await runAsync(async () => mounted?.root.findByProps({ 'data-queue-older': '' }).props.onClick());

const cancelRow = async (id: string): Promise<void> =>
  await runAsync(async () =>
    mounted?.root
      .findByProps({ 'data-queue-row': id })
      .findAll(node => node.type === 'button' && text(node) === 'Cancel message')[0]
      ?.props.onClick(),
  );

const queued = (id: string, words: string) => ({
  v: 1,
  id,
  sender: 'human',
  text: words,
  attachmentIds: [],
  state: 'queued',
  stateAt: '2026-10-30T10:00:00.000Z',
  revision: 1,
  enqueuedAt: '2026-10-30T10:00:00.000Z',
});

const at = (minute: number) => `2026-10-30T10:0${String(minute)}:00.000Z`;
const finished = (id: string, minute: number, words = `words of ${id}`) => ({
  ...queued(id, words),
  state: 'read',
  enqueuedAt: at(minute),
});

describe('QueuePanel', () => {
  test('draws nothing without a ferret to read', () => {
    mounted = render(withClient(daemon({}), <QueuePanel />));
    expect(mounted.toJSON()).toBeNull();
  });

  test('one ferret’s queue is titled by the ferret, and edit and cancel reach the machine', async () => {
    const client = daemon({ '/v1/ferrets/s1/queue': { messages: [queued('q1', 'from the machine')] } });
    open(client);
    await settleUntil(() => page().includes('from the machine'), 'queue shown', runAsync);
    expect(text(mounted!.root.findByType('h1'))).toBe('Queue — Casen');
    expect(client.callsTo(FERRET)[0]?.params).toEqual({ ferretId: 's1' });
    const row = mounted!.root.findByProps({ 'data-queue-row': 'q1' });
    const press = async (label: string) =>
      await runAsync(async () =>
        row.findAll(node => node.type === 'button' && text(node) === label)[0]?.props.onClick(),
      );
    await press('Edit');
    await runAsync(async () => row.findByType('textarea').props.onChange({ target: { value: 'better words' } }));
    await press('Save');
    const [edit] = client.callsTo(EDIT);
    expect(edit?.params).toEqual({ ferretId: 's1', messageId: 'q1' });
    expect(edit?.body).toEqual({ text: 'better words' });
    await press('Cancel message');
    expect(client.callsTo(CANCEL)[0]?.params).toEqual({ ferretId: 's1', messageId: 'q1' });
  });

  test('pressing the ferret opens its chat on Conversation’s chat screen', async () => {
    const client = daemon({ '/v1/ferrets/s1/queue': { messages: [queued('q1', 'from the machine')] } });
    open(client);
    await settleUntil(() => page().includes('from the machine'), 'queue shown', runAsync);
    await runAsync(async () =>
      mounted?.root.findAll(node => node.type === 'button' && text(node) === 'Casen')[0]?.props.onClick(),
    );
    expect(window.location.pathname).toBe('/d1/conversation/chat');
    expect(new URLSearchParams(window.location.search).get('ferret')).toBe('s1');
  });

  test('a ferret whose summary cannot be read is called by its id', async () => {
    const client = daemon({ '/v1/ferrets/s1/queue': { messages: [queued('q1', 'from the machine')] } });
    client.on(FERRET, () => {
      throw new DaemonCallError(404, 'not_found', 'No such ferret.');
    });
    open(client);
    await settleUntil(() => page().includes('from the machine'), 'queue shown', runAsync);
    expect(text(mounted!.root.findByType('h1'))).toBe('Queue — s1');
  });

  test('one ferret’s queue reaches older messages through the cursor when asked, and a poll does not lose them', async () => {
    const client = daemon({
      '/v1/ferrets/s1/queue': { messages: [finished('q2', 2, 'newer words')], nextCursor: 'q2' },
      '/v1/ferrets/s1/queue?before=q2': { messages: [finished('q1', 1, 'older words')], nextCursor: null },
    });
    open(client);
    await settleUntil(() => page().includes('newer words'), 'window shown', runAsync);
    expect(page()).not.toContain('older words');
    expect(olderReads(client)).toEqual([]);

    await pressOlder();
    await settleUntil(() => page().includes('older words'), 'older shown', runAsync);

    expect(queueReads(client)).toContain('/v1/ferrets/s1/queue?before=q2');
    expect(mounted!.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(0);
    expect(page()).toContain('newer words');
  });

  test('after loading every older page the rows are exactly the full history, each once, in order', async () => {
    const client = daemon({
      // The window: the two newest and the one still waiting from long ago.
      '/v1/ferrets/s1/queue': {
        messages: [{ ...queued('q0', 'waiting words'), enqueuedAt: at(0) }, finished('q4', 4), finished('q5', 5)],
        nextCursor: 'q4',
      },
      '/v1/ferrets/s1/queue?before=q4': { messages: [finished('q2', 2), finished('q3', 3)], nextCursor: 'q2' },
      '/v1/ferrets/s1/queue?before=q2': { messages: [finished('q1', 1)], nextCursor: null },
    });
    open(client);
    await settleUntil(() => rowIds().length === 3, 'window shown', runAsync);
    expect(rowIds()).toEqual(['q0', 'q4', 'q5']);

    for (const expected of [5, 6]) {
      await pressOlder();
      await settleUntil(() => rowIds().length === expected, `${String(expected)} rows`, runAsync);
    }

    // The waiting message first, then the history oldest to newest: no message twice, none missing.
    expect(rowIds()).toEqual(['q0', 'q1', 'q2', 'q3', 'q4', 'q5']);
    expect(olderReads(client)).toEqual(['/v1/ferrets/s1/queue?before=q4', '/v1/ferrets/s1/queue?before=q2']);
    expect(mounted!.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(0);
  });

  /**
   * THE RACE (review of #1572): a poll of the window was in the air while the person loaded an older page, and its
   * answer — applied over the history held when the poll BEGAN — erased what had been loaded since.
   */
  test('a window poll still in the air when older messages arrive does not erase them', async () => {
    const window_ = {
      messages: [{ ...queued('q0', 'waiting words'), enqueuedAt: at(0) }, finished('q3', 3), finished('q4', 4)],
      nextCursor: 'q3',
    };
    const answers: Answers = {
      '/v1/ferrets/s1/queue': window_,
      '/v1/ferrets/s1/queue?before=q3': { messages: [finished('q1', 1), finished('q2', 2)], nextCursor: null },
    };
    open(daemon(answers));
    await settleUntil(() => rowIds().length === 3, 'window shown', runAsync);

    // Act — a poll starts (a cancel asks for one) and waits on the machine; meanwhile older messages are loaded.
    let answerPoll: (value: unknown) => void = () => undefined;
    answers['/v1/ferrets/s1/queue'] = new Promise(resolve => {
      answerPoll = resolve;
    });
    await cancelRow('q0');
    await pressOlder();
    await settleUntil(() => rowIds().includes('q1'), 'older shown', runAsync);
    await runAsync(async () => answerPoll(window_));
    await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 20)));

    // Assert — the older page is still there and its button is not offered again.
    expect(rowIds()).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
    expect(mounted!.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(0);
  });

  test('a slower, older answer to the window poll never replaces a newer one that landed first', async () => {
    const waitingAt = (id: string, minute: number, state = 'queued') => ({
      ...queued(id, `words of ${id}`),
      state,
      enqueuedAt: at(minute),
    });
    const answers: Answers = {
      '/v1/ferrets/s1/queue': { messages: [waitingAt('q0', 0), waitingAt('q1', 1)], nextCursor: null },
    };
    // The page's own five-second poll, driven by hand so two reads can be in the air together.
    const beats: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((callback: () => void) => {
      beats.push(callback);
      return 0;
    }) as unknown as typeof setInterval;
    try {
      open(daemon(answers));
      await settleUntil(() => rowIds().length === 2, 'window shown', runAsync);

      // Act — two polls start; the machine answers the second first, then the first.
      const resolvers: Array<(value: unknown) => void> = [];
      const hold = () => {
        answers['/v1/ferrets/s1/queue'] = new Promise(resolve => resolvers.push(resolve));
      };
      const beat = beats.at(-1);
      hold();
      await runAsync(async () => beat?.());
      hold();
      await runAsync(async () => beat?.());
      const cancelledBoth = {
        messages: [waitingAt('q0', 0, 'cancelled'), waitingAt('q1', 1, 'cancelled')],
        nextCursor: null,
      };
      await runAsync(async () => resolvers[1]?.(cancelledBoth));
      await runAsync(async () =>
        resolvers[0]?.({ messages: [waitingAt('q0', 0, 'cancelled'), waitingAt('q1', 1)], nextCursor: null }),
      );
      await runAsync(async () => await new Promise(resolve => setTimeout(resolve, 20)));

      // Assert — the newer answer stands: nothing waits any more.
      expect(resolvers).toHaveLength(2);
      expect(rowIds()).toEqual([]);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  test('keeps Show older messages when the newest window holds only cancelled messages', async () => {
    const second = (n: number) => new Date(Date.UTC(2026, 9, 30, 10, 5, n)).toISOString();
    const cancelled = Array.from({ length: 100 }, (_, n) => ({
      ...queued(`c${String(n).padStart(3, '0')}`, 'taken back'),
      state: 'cancelled',
      enqueuedAt: second(n % 60),
    }));
    const old = { ...queued('old', 'from long ago'), state: 'read', enqueuedAt: '2026-10-30T09:00:00.000Z' };
    const client = daemon({
      '/v1/ferrets/s1/queue': { messages: cancelled, nextCursor: 'c000' },
      '/v1/ferrets/s1/queue?before=c000': { messages: [old], nextCursor: null },
    });
    open(client);
    await settleUntil(() => !page().includes('Reading the queues'), 'queue read', runAsync);

    // Assert — no visible row, and the way to the older message is still there.
    expect(mounted!.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(1);
    await pressOlder();
    await settleUntil(() => page().includes('from long ago'), 'older shown', runAsync);
    expect(queueReads(client)).toContain('/v1/ferrets/s1/queue?before=c000');
  });

  test('a failed read of older messages says so, keeps what is shown and lets the person try again', async () => {
    open(
      daemon({
        '/v1/ferrets/s1/queue': { messages: [finished('q2', 2, 'newer words')], nextCursor: 'q2' },
        '/v1/ferrets/s1/queue?before=q2': new DaemonCallError(503, 'unreachable', 'offline'),
      }),
    );
    await settleUntil(() => page().includes('newer words'), 'window shown', runAsync);

    await pressOlder();
    await settleUntil(() => page().includes('could not be read'), 'failure said', runAsync);

    expect(page()).toContain('newer words');
    expect(mounted!.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(1);
  });

  test('an older page asked before a window restarted the walk is not merged: it is asked again on the new walk', async () => {
    const answers: Answers = {
      '/v1/ferrets/s1/queue': {
        messages: [{ ...queued('q0', 'waiting words'), enqueuedAt: at(0) }, finished('q4', 4), finished('q5', 5)],
        nextCursor: 'q4',
      },
      '/v1/ferrets/s1/queue?before=q4': { messages: [finished('q2', 2), finished('q3', 3)], nextCursor: 'q2' },
    };
    open(daemon(answers));
    await settleUntil(() => rowIds().length === 3, 'initial window', runAsync);
    await pressOlder();
    await settleUntil(() => rowIds().includes('q2'), 'first older page', runAsync);

    let resolveOlder: (value: unknown) => void = () => {};
    answers['/v1/ferrets/s1/queue?before=q2'] = new Promise(resolve => {
      resolveOlder = resolve;
    });
    await pressOlder();
    // Cancel q0 while the second older page is in flight. Its absence from the next window resets the history.
    answers['/v1/ferrets/s1/queue'] = { messages: [finished('q4', 4), finished('q5', 5)], nextCursor: 'q4' };
    await cancelRow('q0');
    await settleUntil(() => !rowIds().includes('q0'), 'window reset', runAsync);
    await runAsync(async () => resolveOlder({ messages: [finished('q1', 1)], nextCursor: null }));
    // The late page named the old walk: it is dropped (q1 never shows, the walk is not claimed finished) and the page is
    // asked again from the restarted walk's cursor, which brings q2 and q3 back.
    await settleUntil(() => rowIds().includes('q2'), 'the page asked again on the new walk', runAsync);
    expect(rowIds()).toEqual(['q2', 'q3', 'q4', 'q5']);
    expect(mounted!.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(1);
  });

  test('a machine that cannot be reached shows only what this device holds for it', async () => {
    const outbox = deviceOutbox();
    await outbox.outbox.submit({ daemonId: 'd1', ferretId: 's1', message: 'still here' });
    await outbox.outbox.submit({ daemonId: 'd1', ferretId: 's2', message: 'for another ferret' });
    open(daemon({}, true), outbox);
    await settleUntil(() => !page().includes('Reading the queues'), 'queues read', runAsync);
    expect(page()).toContain('still here');
    expect(page()).toContain('waiting for connection');
    expect(page()).not.toContain('for another ferret');
  });
});
