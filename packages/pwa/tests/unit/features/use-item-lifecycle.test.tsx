import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type AgendaConversationEntry, type AgendaItem } from '@ferretry/protocol';
import { useState } from 'react';
import {
  type ItemLifecycle,
  type UseItemLifecycleInput,
  useItemLifecycle,
} from '../../../src/features/agenda/use-item-lifecycle.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { type AppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { browserFetch } from '../../../src/lib/runtime-models.ts';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { settleUntil } from '../../support/settle.ts';

const connection = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const scope = daemonSessionScope(connection, 'sess');

let view: Mounted | null = null;
const realFetch = globalThis.fetch;
let calls: Array<{ method: string; path: string; body?: string }> = [];
let versions: { latest: number; seen?: number } = { latest: 3, seen: 1 };
let fail = false;
let hold: Promise<void> | null = null;
let endless = false;
let thread = ['one', 'two', 'three'];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const at = '2026-11-01T10:00:00.000Z';
const summary = (version: number) => ({ version, at, by: 'ferret', change: 'edited', lifecycle: 'active' });
const entry = (text: string): AgendaConversationEntry => ({ at, by: 'owner', text, via: 'reply' });

beforeEach(() => {
  calls = [];
  versions = { latest: 3, seen: 1 };
  fail = false;
  hold = null;
  endless = false;
  thread = ['one', 'two', 'three'];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/v1/sessions/sess/agenda/A5', '') + url.search;
    calls.push({
      method: init?.method ?? 'GET',
      path,
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
    });
    if (fail) return json({ error: 'gone', code: 'not-found' }, 404);
    if (path === '/versions') {
      return json({ sessionId: 'sess', id: 'A5', ...versions, versions: [summary(1), summary(2), summary(3)] });
    }
    if (path === '/seen') return json({ seen: versions.latest });
    if (path.startsWith('/versions/')) {
      const version = Number(path.split('/')[2]);
      return json({ ...summary(version), item: agendaItem('A5', { subject: `v${String(version)}` }) });
    }
    if (path.startsWith('/conversation')) {
      await hold;
      const index = Number(url.searchParams.get('index'));
      const offset = Number(url.searchParams.get('offset'));
      if (endless) return json({ total: 3, index, offset, entry: entry('x'), next: { index, offset: offset + 1 } });
      return json({
        total: thread.length,
        index,
        offset: 0,
        entry: entry(thread[index] ?? ''),
        ...(index < thread.length - 1 ? { next: { index: index + 1, offset: 0 } } : {}),
      });
    }
    return json({}, 404);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await view?.unmount();
  view = null;
});

let latest: ItemLifecycle | null = null;
let update: ((input: UseItemLifecycleInput) => void) | null = null;
const Probe = ({ initial }: { readonly initial: UseItemLifecycleInput }) => {
  const [input, setInput] = useState(initial);
  update = setInput;
  latest = useItemLifecycle(input);
  return null;
};

const draw = async (item: AgendaItem | undefined, extra: Partial<UseItemLifecycleInput> = {}): Promise<void> => {
  const store = { carrier: { fetch: browserFetch } } as unknown as AppStore;
  const input: UseItemLifecycleInput = {
    connection,
    scope,
    client: { merge: async () => undefined },
    item,
    board: [],
    ...extra,
  };
  view = await mount(
    <StoreProvider store={store}>
      <Probe initial={input} />
    </StoreProvider>,
  );
  await interact(() => Promise.resolve());
};

const inputOf = (item: AgendaItem): UseItemLifecycleInput => ({
  connection,
  scope,
  client: { merge: async () => undefined },
  item,
  board: [],
});

const base = (overrides: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem('A5', { revisions: [{}, {}] as never, ...overrides });

describe('what an open item knows about its own life', () => {
  test('names the agendas an item was merged into or split from by title', async () => {
    await draw(base({ mergedInto: 'A2', splitInto: ['A7', 'A8'] } as never), {
      board: [
        agendaItem('A2', { subject: 'Where do snoozed items go?' }),
        agendaItem('A7', { subject: 'Badge count' }),
      ],
    });
    expect(latest?.lineageTitles).toEqual({ A2: 'Where do snoozed items go?', A7: 'Badge count' });
    await view?.unmount();
    await draw(base());
    expect(latest?.lineageTitles).toBeUndefined();
  });

  test('offers nothing for a machine agenda or with nothing open', async () => {
    await draw(base(), { scope: daemonSessionScope(connection, 'machine-agenda') });
    expect(latest).toEqual({ conversation: null });
    await view?.unmount();
    await draw(undefined);
    expect(latest).toEqual({ conversation: null });
    expect(calls).toEqual([]);
  });

  test('keeps the mark from BEFORE this opening as the baseline, then marks the newest version seen', async () => {
    await draw(base());
    await settleUntil(() => latest?.versions !== undefined, 'the versions', interact);
    expect(latest?.versions?.list.seen).toBe(1);
    expect(latest?.versions?.list.latest).toBe(3);
    await settleUntil(() => calls.some(call => call.method === 'PUT'), 'the seen mark', interact);
    expect(calls.find(call => call.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/seen',
      body: JSON.stringify({ version: 3 }),
    });
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  });

  test('offers no diff for an item with one version, but still marks it seen', async () => {
    versions = { latest: 1 };
    await draw(agendaItem('A5'));
    await settleUntil(() => calls.some(call => call.method === 'PUT'), 'the seen mark', interact);
    expect(latest?.versions).toBeUndefined();
  });

  test('reads one version once however often it is asked for', async () => {
    await draw(base());
    await settleUntil(() => latest?.versions !== undefined, 'the versions', interact);
    const first = await latest?.versions?.load(2);
    await latest?.versions?.load(2);
    expect(first?.subject).toBe('v2');
    expect(calls.filter(call => call.path === '/versions/2')).toHaveLength(1);
  });

  test('keeps drawing the item the older way when the machine does not answer', async () => {
    fail = true;
    await draw(base());
    await interact(() => Promise.resolve());
    expect(latest?.versions).toBeUndefined();
    expect(latest?.conversation).toBeNull();
  });

  test('uses the item’s own tail when it is the whole thread, and reads the rest when it is not', async () => {
    await draw(base({ conversationCount: 1, conversation: [entry('whole')] }));
    expect(latest?.conversation?.map(each => each.text)).toEqual(['whole']);
    expect(calls.some(call => call.path.startsWith('/conversation'))).toBe(false);
    await view?.unmount();

    await draw(base({ conversationCount: 3, conversation: [entry('three')] }));
    await settleUntil(() => latest?.conversation?.length === 3, 'the whole thread', interact);
    expect(latest?.conversation?.map(each => each.text)).toEqual(['one', 'two', 'three']);
  });

  test('draws the item’s own tail at once and says how many earlier entries are still being read', async () => {
    let release: () => void = () => undefined;
    hold = new Promise<void>(resolve => {
      release = resolve;
    });
    await draw(base({ conversationCount: 3, conversation: [entry('three')] }));
    expect(latest?.conversation?.map(each => each.text)).toEqual(['three']);
    expect(latest?.conversationGap).toEqual({ at: 0, count: 2, state: 'loading' });
    release();
    await settleUntil(() => latest?.conversationGap === undefined, 'the earlier entries', interact);
    expect(latest?.conversation?.map(each => each.text)).toEqual(['one', 'two', 'three']);
  });

  test('reads only the entries it does not have yet when a reply arrives, and only those the tail lacks', async () => {
    await draw(base({ conversationCount: 3, conversation: [entry('three')] }));
    await settleUntil(() => latest?.conversationGap === undefined, 'the earlier entries', interact);
    expect(calls.filter(call => call.path.startsWith('/conversation')).map(call => call.path)).toEqual([
      '/conversation?index=0&offset=0',
      '/conversation?index=1&offset=0',
    ]);

    thread = ['one', 'two', 'three', 'four', 'five'];
    calls = [];
    await interact(() =>
      update?.({ ...inputOf(base({ conversationCount: 5, conversation: [entry('four'), entry('five')] })) }),
    );
    await settleUntil(() => latest?.conversation?.length === 5, 'the new entries', interact);
    expect(latest?.conversation?.map(each => each.text)).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(calls.filter(call => call.path.startsWith('/conversation')).map(call => call.path)).toEqual([
      '/conversation?index=2&offset=0',
    ]);
  });

  test('reads nothing more when a longer tail already holds what was still missing', async () => {
    await draw(base({ conversationCount: 3, conversation: [entry('three')] }));
    await settleUntil(() => latest?.conversationGap === undefined, 'the earlier entries', interact);

    calls = [];
    await interact(() =>
      update?.({
        ...inputOf(base({ conversationCount: 4, conversation: [entry('two'), entry('three'), entry('four')] })),
      }),
    );
    await interact(() => Promise.resolve());
    expect(latest?.conversation?.map(each => each.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(latest?.conversationGap).toBeUndefined();
    expect(calls.filter(call => call.path.startsWith('/conversation'))).toEqual([]);
  });

  test('says so, and draws only what it has, when a thread is longer than one read takes', async () => {
    endless = true;
    await draw(base({ conversationCount: 3, conversation: [entry('three')] }));
    await settleUntil(() => latest?.conversationGap?.state === 'capped', 'the read limit', interact);
    expect(latest?.conversationGap).toEqual({ at: 0, count: 2, state: 'capped' });
    expect(latest?.conversation?.map(each => each.text)).toEqual(['three']);
  });

  test('says the earlier entries could not be read, and keeps the tail, when the machine does not answer', async () => {
    fail = true;
    await draw(base({ conversationCount: 3, conversation: [entry('three')] }));
    await settleUntil(() => latest?.conversationGap?.state === 'failed', 'the failure', interact);
    expect(latest?.conversation?.map(each => each.text)).toEqual(['three']);
    expect(latest?.conversationGap).toEqual({ at: 0, count: 2, state: 'failed' });
  });

  test('reads the thread again from the start when a merge interleaves another thread into it', async () => {
    await draw(base({ conversationCount: 3, conversation: [entry('three')] }));
    await settleUntil(() => latest?.conversationGap === undefined, 'the earlier entries', interact);
    expect(latest?.conversation?.map(each => each.text)).toEqual(['one', 'two', 'three']);

    thread = ['one', 'zero', 'two', 'three', 'four'];
    calls = [];
    await interact(() =>
      update?.(
        inputOf(
          base({ conversationCount: 5, conversation: [entry('three'), entry('four')], mergedFrom: ['A6'] } as never),
        ),
      ),
    );
    await settleUntil(
      () => latest?.conversationGap === undefined && latest?.conversation?.length === 5,
      'the merged thread',
      interact,
    );
    expect(latest?.conversation?.map(each => each.text)).toEqual(['one', 'zero', 'two', 'three', 'four']);
    expect(calls.filter(call => call.path.startsWith('/conversation'))[0]?.path).toBe('/conversation?index=0&offset=0');
  });

  test('tries the earlier entries again when the thread grows after a failed read', async () => {
    fail = true;
    await draw(base({ conversationCount: 3, conversation: [entry('three')] }));
    await settleUntil(() => latest?.conversationGap?.state === 'failed', 'the failure', interact);

    fail = false;
    thread = ['one', 'two', 'three', 'four'];
    await interact(() =>
      update?.(inputOf(base({ conversationCount: 4, conversation: [entry('three'), entry('four')] }))),
    );
    await settleUntil(() => latest?.conversationGap === undefined, 'the retry', interact);
    expect(latest?.conversation?.map(each => each.text)).toEqual(['one', 'two', 'three', 'four']);
  });

  test('names an agenda merged away by its title, though a closed one is not on the board', async () => {
    await draw(base({ mergedFrom: ['A6'] } as never), {
      records: [agendaItem('A6', { subject: 'Where do ferrets sleep?' })],
    });
    expect(latest?.lineageTitles).toEqual({ A6: 'Where do ferrets sleep?' });
  });

  test('draws the rebuilt thread when the item stores no words', async () => {
    await draw(base());
    expect(latest?.conversation).toBeNull();
  });

  test('offers a merge with the other open agendas, and sends it through the client', async () => {
    const sent: unknown[][] = [];
    const client = {
      merge: async (...args: unknown[]) => {
        sent.push(args);
      },
    };
    await draw(base(), {
      client: client as never,
      board: [agendaItem('A2'), agendaItem('A5'), agendaItem('A9', { notice: true })],
    });
    expect(latest?.merge?.candidates.map(each => each.id)).toEqual(['A2']);
    await latest?.merge?.merge('A5', 'A2');
    expect(sent).toEqual([[connection, scope, 'A5', 'A2']]);
  });

  test('offers no merge without a client that merges, or for an item that cannot merge', async () => {
    await draw(base(), { client: undefined });
    expect(latest?.merge).toBeUndefined();
    await view?.unmount();
    await draw(base(), { client: {} });
    expect(latest?.merge).toBeUndefined();
    await view?.unmount();
    await draw(base({ notice: true }));
    expect(latest?.merge).toBeUndefined();
  });
});
