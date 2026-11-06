import { afterEach, describe, expect, test } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { QueuePage } from '../../src/components/queue-page.tsx';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { RouterProvider } from '../../src/lib/router.tsx';
import { MemoryOutboxBackend } from '../../src/lib/send-outbox.ts';
import { type AppStore, createAppStore, StoreProvider } from '../../src/lib/store.tsx';
import '../support/dom.ts';
import { render, runAsync } from '../support/react.ts';
import { settleUntil } from '../support/settle.ts';

class Memory implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();
  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'device' });
const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.example.test', deviceId: 'device' });
const view = (id: string, name: string, teammate?: string) =>
  ({
    config: { id, name, ...(teammate ? { teammate } : {}) },
    state: { id, status: 'running', turn: 1 },
  }) as never;

let mounted: ReactTestRenderer | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const text = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : text(child))).join('');

const open = async (
  queues: Readonly<Record<string, unknown>>,
  down: readonly string[] = [],
  fleetSource: 'stubbed' | 'real' = 'stubbed',
) => {
  const calls: string[] = [];
  const real = await createAppStore({
    repository: new Memory(),
    connectClient: async connection => {
      if (down.includes(connection.daemonId)) throw new Error('unreachable');
      return {
        request: async (path: string, _schema: unknown, init: RequestInit) => {
          calls.push(`${init.method ?? 'GET'} ${path}`);
          const answer = queues[path];
          if (answer instanceof Error) throw answer;
          return answer ?? { messages: [] };
        },
      } as unknown as FyApiClient;
    },
    fetcher: async () => Response.json({}),
    outboxBackend: new MemoryOutboxBackend(),
  });
  real.connections.add(alpha);
  real.connections.add(beta);
  if (fleetSource === 'real') {
    // The fleet the app itself owns, seeded: the page must survive the real
    // DaemonFleetStore, not only the hand-written stub below.
    real.fleet.seed(alpha, [view('s1', 'one', 'Casen'), view('s2', 'two')], Date.now());
    real.fleet.seed(beta, [view('s3', 'three', 'Mira')], Date.now());
    return { store: real, real, calls };
  }
  const fleet = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
  };
  const snapshot = {
    daemons: new Map([
      ['alpha', { sessions: [view('s1', 'one', 'Casen'), view('s2', 'two')] }],
      ['beta', { sessions: [view('s3', 'three', 'Mira')] }],
    ]),
  };
  const store = { ...real, fleet } as unknown as AppStore;
  return { store, real, calls };
};

const queued = (id: string, text: string) => ({
  v: 1,
  id,
  sender: 'human',
  text,
  attachmentIds: [],
  state: 'queued',
  stateAt: '2026-10-30T10:00:00.000Z',
  revision: 1,
  enqueuedAt: '2026-10-30T10:00:00.000Z',
});

describe('QueuePage', () => {
  /**
   * THE CRASH ITSELF (&B160): the Actions-menu Queue entry opened a page that
   * failed to load. The container handed `store.fleet.subscribe` and
   * `store.fleet.getSnapshot` to `useSyncExternalStore` detached; on the real
   * `DaemonFleetStore` those were prototype methods over private fields, so the
   * first render threw. The stubbed fleet below could never catch it — its
   * methods are safe to detach — so this case runs the real store.
   */
  test('mounts against the real fleet store — the Actions-menu Queue route crashed there', async () => {
    const { store, calls } = await open(
      { '/v1/sessions/s1/queue': { messages: [queued('q1', 'from the machine')] } },
      [],
      'real',
    );
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
        </StoreProvider>
      </RouterProvider>,
    );
    await settleUntil(() => JSON.stringify(mounted?.toJSON()).includes('from the machine'), 'queue shown', runAsync);
    expect(text(mounted.root.findByType('h1'))).toBe('Queue — Casen');
    expect(calls).toContain('GET /v1/sessions/s1/queue');
  });

  test('All queues shows only ferrets with something waiting, across machines, including this device’s outbox', async () => {
    const { store, real } = await open({
      '/v1/sessions/s1/queue': { messages: [queued('q1', 'from the machine')] },
      '/v1/sessions/s3/queue': { messages: [] },
    });
    await real.outbox.submit({ daemonId: 'beta', sessionId: 's3', message: 'thank you' }, undefined);
    await real.outbox.submit({ daemonId: 'alpha', sessionId: 'gone', message: 'to a ferret not listed' });
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} />
        </StoreProvider>
      </RouterProvider>,
    );
    await settleUntil(() => !JSON.stringify(mounted?.toJSON()).includes('Reading the queues'), 'queues read', runAsync);
    const page = JSON.stringify(mounted.toJSON());
    expect(page).toContain('All queues');
    expect(page).toContain('from the machine');
    expect(page).toContain('thank you');
    expect(page).toContain('to a ferret not listed');
    expect(page).toContain('Casen');
    expect(page).toContain('Mira');
    expect(page).not.toContain('"two"');
    expect(page).toContain('alpha');
  });

  test('one ferret’s queue is titled by the ferret, offers All queues, and edit and cancel reach the machine', async () => {
    const { store, calls } = await open({ '/v1/sessions/s1/queue': { messages: [queued('q1', 'from the machine')] } });
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
        </StoreProvider>
      </RouterProvider>,
    );
    await settleUntil(() => JSON.stringify(mounted?.toJSON()).includes('from the machine'), 'queue shown', runAsync);
    expect(text(mounted.root.findByType('h1'))).toBe('Queue — Casen');
    const row = mounted.root.findByProps({ 'data-queue-row': 'q1' });
    const press = async (label: string) =>
      await runAsync(async () =>
        row.findAll(node => node.type === 'button' && text(node) === label)[0]?.props.onClick(),
      );
    await runAsync(async () =>
      row.findAll(node => node.type === 'button' && text(node) === 'Edit')[0]?.props.onClick(),
    );
    await runAsync(async () => row.findByType('textarea').props.onChange({ target: { value: 'better words' } }));
    await press('Save');
    expect(calls).toContain('PATCH /v1/sessions/s1/queue/q1');
    await press('Cancel message');
    expect(calls).toContain('DELETE /v1/sessions/s1/queue/q1');
    await runAsync(async () =>
      mounted?.root.findAll(node => node.type === 'button' && text(node) === 'All queues')[0]?.props.onClick(),
    );
  });

  test('one ferret’s queue reaches older messages through the cursor when asked, and a poll does not lose them', async () => {
    const finished = (id: string, text: string, minute: number) => ({
      ...queued(id, text),
      state: 'read',
      enqueuedAt: `2026-10-30T10:0${String(minute)}:00.000Z`,
    });
    const { store, calls } = await open({
      '/v1/sessions/s1/queue': { messages: [finished('q2', 'newer words', 2)], nextCursor: 'q2' },
      '/v1/sessions/s1/queue?before=q2': { messages: [finished('q1', 'older words', 1)], nextCursor: null },
    });
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
        </StoreProvider>
      </RouterProvider>,
    );
    await settleUntil(() => JSON.stringify(mounted?.toJSON()).includes('newer words'), 'window shown', runAsync);
    expect(JSON.stringify(mounted.toJSON())).not.toContain('older words');
    expect(calls.filter(call => call.includes('before'))).toEqual([]);

    await runAsync(async () => mounted?.root.findByProps({ 'data-queue-older': '' }).props.onClick());
    await settleUntil(() => JSON.stringify(mounted?.toJSON()).includes('older words'), 'older shown', runAsync);

    expect(calls).toContain('GET /v1/sessions/s1/queue?before=q2');
    expect(mounted.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(0);
    expect(JSON.stringify(mounted.toJSON())).toContain('newer words');
  });

  test('after loading every older page the rows are exactly the full history, each once, in order', async () => {
    const at = (minute: number) => `2026-10-30T10:0${String(minute)}:00.000Z`;
    const finished = (id: string, minute: number) => ({
      ...queued(id, `words of ${id}`),
      state: 'read',
      enqueuedAt: at(minute),
    });
    const { store, calls } = await open({
      // The window: the two newest and the one still waiting from long ago.
      '/v1/sessions/s1/queue': {
        messages: [{ ...queued('q0', 'waiting words'), enqueuedAt: at(0) }, finished('q4', 4), finished('q5', 5)],
        nextCursor: 'q4',
      },
      '/v1/sessions/s1/queue?before=q4': { messages: [finished('q2', 2), finished('q3', 3)], nextCursor: 'q2' },
      '/v1/sessions/s1/queue?before=q2': { messages: [finished('q1', 1)], nextCursor: null },
    });
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
        </StoreProvider>
      </RouterProvider>,
    );
    const rowIds = (): string[] =>
      (
        mounted?.root.findAll(node => typeof node.type === 'string' && node.props['data-queue-row'] !== undefined) ?? []
      ).map(node => String(node.props['data-queue-row']));
    await settleUntil(() => rowIds().length === 3, 'window shown', runAsync);
    expect(rowIds()).toEqual(['q0', 'q4', 'q5']);

    for (const expected of [5, 6]) {
      await runAsync(async () => mounted?.root.findByProps({ 'data-queue-older': '' }).props.onClick());
      await settleUntil(() => rowIds().length === expected, `${String(expected)} rows`, runAsync);
    }

    // The waiting message first, then the history oldest to newest: no message twice, none missing.
    expect(rowIds()).toEqual(['q0', 'q1', 'q2', 'q3', 'q4', 'q5']);
    expect(calls.filter(call => call.includes('before'))).toEqual([
      'GET /v1/sessions/s1/queue?before=q4',
      'GET /v1/sessions/s1/queue?before=q2',
    ]);
    expect(mounted.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(0);
  });

  /**
   * THE RACE (review of #1572): a poll of the window was in the air while the person loaded an older page, and its
   * answer — applied over the history held when the poll BEGAN — erased what had been loaded since.
   */
  test('a window poll still in the air when older messages arrive does not erase them', async () => {
    const at = (minute: number) => `2026-10-30T10:0${String(minute)}:00.000Z`;
    const finished = (id: string, minute: number) => ({
      ...queued(id, `words of ${id}`),
      state: 'read',
      enqueuedAt: at(minute),
    });
    const window = {
      messages: [{ ...queued('q0', 'waiting words'), enqueuedAt: at(0) }, finished('q3', 3), finished('q4', 4)],
      nextCursor: 'q3',
    };
    const answers: Record<string, unknown> = {
      '/v1/sessions/s1/queue': window,
      '/v1/sessions/s1/queue?before=q3': { messages: [finished('q1', 1), finished('q2', 2)], nextCursor: null },
    };
    const { store } = await open(answers);
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
        </StoreProvider>
      </RouterProvider>,
    );
    const rowIds = (): string[] =>
      (
        mounted?.root.findAll(node => typeof node.type === 'string' && node.props['data-queue-row'] !== undefined) ?? []
      ).map(node => String(node.props['data-queue-row']));
    await settleUntil(() => rowIds().length === 3, 'window shown', runAsync);

    // Act — a poll starts (a cancel asks for one) and waits on the machine; meanwhile older messages are loaded.
    let answerPoll: (value: unknown) => void = () => undefined;
    answers['/v1/sessions/s1/queue'] = new Promise(resolve => {
      answerPoll = resolve;
    });
    await runAsync(async () =>
      mounted?.root
        .findByProps({ 'data-queue-row': 'q0' })
        .findAll(node => node.type === 'button' && text(node) === 'Cancel message')[0]
        ?.props.onClick(),
    );
    await runAsync(async () => mounted?.root.findByProps({ 'data-queue-older': '' }).props.onClick());
    await settleUntil(() => rowIds().includes('q1'), 'older shown', runAsync);
    await runAsync(async () => answerPoll(window));
    await new Promise(resolve => setTimeout(resolve, 20));

    // Assert — the older page is still there and its button is not offered again.
    expect(rowIds()).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
    expect(mounted.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(0);
  });

  test('a slower, older answer to the window poll never replaces a newer one that landed first', async () => {
    const at = (minute: number) => `2026-10-30T10:0${String(minute)}:00.000Z`;
    const waitingAt = (id: string, minute: number, state = 'queued') => ({
      ...queued(id, `words of ${id}`),
      state,
      enqueuedAt: at(minute),
    });
    const answers: Record<string, unknown> = {
      '/v1/sessions/s1/queue': { messages: [waitingAt('q0', 0), waitingAt('q1', 1)], nextCursor: null },
    };
    const { store } = await open(answers);
    // The page's own five-second poll, driven by hand so two reads can be in the air together.
    const beats: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((callback: () => void) => {
      beats.push(callback);
      return 0;
    }) as unknown as typeof setInterval;
    try {
      mounted = render(
        <RouterProvider>
          <StoreProvider store={store}>
            <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
          </StoreProvider>
        </RouterProvider>,
      );
      const rowIds = (): string[] =>
        (
          mounted?.root.findAll(node => typeof node.type === 'string' && node.props['data-queue-row'] !== undefined) ??
          []
        ).map(node => String(node.props['data-queue-row']));
      await settleUntil(() => rowIds().length === 2, 'window shown', runAsync);

      // Act — two polls start; the machine answers the second first, then the first.
      const resolvers: Array<(value: unknown) => void> = [];
      const hold = () => {
        answers['/v1/sessions/s1/queue'] = new Promise(resolve => resolvers.push(resolve));
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
      await new Promise(resolve => setTimeout(resolve, 20));

      // Assert — the newer answer stands: nothing waits any more.
      expect(resolvers).toHaveLength(2);
      expect(rowIds()).toEqual([]);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  test('keeps Show older messages when the newest window holds only cancelled messages', async () => {
    const at = (second: number) => new Date(Date.UTC(2026, 9, 30, 10, 5, second)).toISOString();
    const cancelled = Array.from({ length: 100 }, (_, n) => ({
      ...queued(`c${String(n).padStart(3, '0')}`, 'taken back'),
      state: 'cancelled',
      enqueuedAt: at(n % 60),
    }));
    const old = { ...queued('old', 'from long ago'), state: 'read', enqueuedAt: '2026-10-30T09:00:00.000Z' };
    const { store, calls } = await open({
      '/v1/sessions/s1/queue': { messages: cancelled, nextCursor: 'c000' },
      '/v1/sessions/s1/queue?before=c000': { messages: [old], nextCursor: null },
    });
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
        </StoreProvider>
      </RouterProvider>,
    );
    await settleUntil(() => !JSON.stringify(mounted?.toJSON()).includes('Reading the queues'), 'queue read', runAsync);

    // Assert — no visible row, and the way to the older message is still there.
    expect(mounted.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(1);
    await runAsync(async () => mounted?.root.findByProps({ 'data-queue-older': '' }).props.onClick());
    await settleUntil(() => JSON.stringify(mounted?.toJSON()).includes('from long ago'), 'older shown', runAsync);
    expect(calls).toContain('GET /v1/sessions/s1/queue?before=c000');
  });

  test('a failed read of older messages says so, keeps what is shown and lets the person try again', async () => {
    const finished = { ...queued('q2', 'newer words'), state: 'read' };
    const { store } = await open({
      '/v1/sessions/s1/queue': { messages: [finished], nextCursor: 'q2' },
      '/v1/sessions/s1/queue?before=q2': new Error('offline'),
    });
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
        </StoreProvider>
      </RouterProvider>,
    );
    await settleUntil(() => JSON.stringify(mounted?.toJSON()).includes('newer words'), 'window shown', runAsync);

    await runAsync(async () => mounted?.root.findByProps({ 'data-queue-older': '' }).props.onClick());
    await settleUntil(() => JSON.stringify(mounted?.toJSON()).includes('could not be read'), 'failure said', runAsync);

    expect(JSON.stringify(mounted.toJSON())).toContain('newer words');
    expect(mounted.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(1);
  });

  test('an older page asked before a window restarted the walk is not merged: it is asked again on the new walk', async () => {
    const at = (minute: number) => `2026-10-30T10:0${String(minute)}:00.000Z`;
    const finished = (id: string, minute: number) => ({
      ...queued(id, `words of ${id}`),
      state: 'read',
      enqueuedAt: at(minute),
    });
    const answers: Record<string, unknown> = {
      '/v1/sessions/s1/queue': {
        messages: [{ ...queued('q0', 'waiting words'), enqueuedAt: at(0) }, finished('q4', 4), finished('q5', 5)],
        nextCursor: 'q4',
      },
      '/v1/sessions/s1/queue?before=q4': { messages: [finished('q2', 2), finished('q3', 3)], nextCursor: 'q2' },
    };
    const { store } = await open(answers);
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
        </StoreProvider>
      </RouterProvider>,
    );
    const rowIds = () =>
      (
        mounted?.root.findAll(node => typeof node.type === 'string' && node.props['data-queue-row'] !== undefined) ?? []
      ).map(node => String(node.props['data-queue-row']));
    await settleUntil(() => rowIds().length === 3, 'initial window', runAsync);
    await runAsync(async () => mounted?.root.findByProps({ 'data-queue-older': '' }).props.onClick());
    await settleUntil(() => rowIds().includes('q2'), 'first older page', runAsync);

    let resolveOlder: (value: unknown) => void = () => {};
    answers['/v1/sessions/s1/queue?before=q2'] = new Promise(resolve => {
      resolveOlder = resolve;
    });
    await runAsync(async () => mounted?.root.findByProps({ 'data-queue-older': '' }).props.onClick());
    // Cancel q0 while the second older page is in flight. Its absence from the next window resets the history.
    answers['/v1/sessions/s1/queue'] = { messages: [finished('q4', 4), finished('q5', 5)], nextCursor: 'q4' };
    await runAsync(async () =>
      mounted?.root
        .findByProps({ 'data-queue-row': 'q0' })
        .findAll(node => node.type === 'button' && text(node) === 'Cancel message')[0]
        ?.props.onClick(),
    );
    await settleUntil(() => !rowIds().includes('q0'), 'window reset', runAsync);
    await runAsync(async () => resolveOlder({ messages: [finished('q1', 1)], nextCursor: null }));
    // The late page named the old walk: it is dropped (q1 never shows, the walk is not claimed finished) and the page is
    // asked again from the restarted walk's cursor, which brings q2 and q3 back.
    await settleUntil(() => rowIds().includes('q2'), 'the page asked again on the new walk', runAsync);
    expect(rowIds()).toEqual(['q2', 'q3', 'q4', 'q5']);
    expect(mounted.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(1);
  });

  test('All queues never offers older messages: everything waiting is already in the window', async () => {
    const { store } = await open({
      '/v1/sessions/s1/queue': { messages: [queued('q1', 'from the machine')], nextCursor: 'q1' },
    });
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} />
        </StoreProvider>
      </RouterProvider>,
    );
    await settleUntil(() => JSON.stringify(mounted?.toJSON()).includes('from the machine'), 'queue shown', runAsync);
    expect(mounted.root.findAllByProps({ 'data-queue-older': '' })).toHaveLength(0);
  });

  test('a machine that cannot be reached shows only what this device holds for it, and a lone machine names no machine', async () => {
    const { store, real } = await open({}, ['alpha', 'beta']);
    await real.outbox.submit({ daemonId: 'alpha', sessionId: 's1', message: 'still here' });
    mounted = render(
      <RouterProvider>
        <StoreProvider store={store}>
          <QueuePage daemonId={alpha.daemonId} sessionId="s1" />
        </StoreProvider>
      </RouterProvider>,
    );
    await settleUntil(() => !JSON.stringify(mounted?.toJSON()).includes('Reading the queues'), 'queues read', runAsync);
    expect(JSON.stringify(mounted.toJSON())).toContain('still here');
  });
});
