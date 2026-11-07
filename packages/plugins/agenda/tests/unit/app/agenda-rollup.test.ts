import { describe, expect, it } from 'bun:test';
import {
  AgendaRollupStore as RollupStore,
  fetchAgendaRollup as fetchRollup,
  ROLLUP_MAX_PAGES,
} from '../../../app/lib/agenda-rollup.ts';
import type { DaemonConnection } from '../../../app/shell.ts';
import { callFromFetch, type TestFetch } from '../../support/app/call-from-fetch.ts';
import { daemonConnection } from '../../../app/shell.ts';
import { DaemonResponseError } from '../../../app/shell.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

/** The roll-up over a scripted fetcher, through the half's client. */
const fetchAgendaRollup = (connection: DaemonConnection, fetcher: TestFetch) =>
  fetchRollup(connection, callFromFetch(fetcher));
class AgendaRollupStore extends RollupStore {
  constructor(fetcher: TestFetch) {
    super(callFromFetch(fetcher));
  }
}

const daemon = daemonConnection({ daemonId: 'daemon-a' });
const other = daemonConnection({ daemonId: 'daemon-b' });

const reply = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const page = (ids: readonly string[], next?: string) => ({
  sessions: ids.map(sessionId => ({ sessionId, items: [agendaItem('A1')] })),
  ...(next === undefined ? {} : { next }),
});
const urls = (): { calls: string[]; fetcher: TestFetch } => {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async input => {
      calls.push(String(input));
      return reply(page(['s']));
    },
  };
};

describe('fetchAgendaRollup', () => {
  it('reads every page, following `next` as `after`', async () => {
    const calls: string[] = [];
    const pages = [page(['a', 'b'], 'b'), page(['c'])];
    const boards = await fetchAgendaRollup(daemon, async (input, init) => {
      // GAP(agenda-channel-header): the client carries no channel header, so whole records come back.
      expect(new Headers(init.headers).has('x-fy-agenda-channel')).toBe(false);
      calls.push(String(input));
      return reply(pages.shift());
    });
    expect([...boards.keys()]).toEqual(['a', 'b', 'c']);
    expect(calls).toEqual(['https://daemon.test/v1/agenda/open', 'https://daemon.test/v1/agenda/open?after=b']);
  });

  it('fails on a refusal, on a page that is not the contract and on a daemon that never stops', async () => {
    const refused = fetchAgendaRollup(daemon, async () => reply({}, 403));
    await expect(refused).rejects.toBeInstanceOf(DaemonResponseError);
    await expect(fetchAgendaRollup(daemon, async () => reply({ nope: true }))).rejects.toThrow();
    let spins = 0;
    const endless = fetchAgendaRollup(daemon, async () => {
      spins++;
      return reply(page(['s'], 's'));
    });
    await expect(endless).rejects.toBeInstanceOf(DaemonResponseError);
    expect(spins).toBe(ROLLUP_MAX_PAGES);
  });
});

describe('AgendaRollupStore', () => {
  it('holds a machine read to the end and says it is complete', async () => {
    const { fetcher } = urls();
    const store = new AgendaRollupStore(fetcher);
    let heard = 0;
    const off = store.subscribe(() => (heard += 1));
    expect(store.getSnapshot().complete.size).toBe(0);
    await store.read(daemon);
    const held = store.getSnapshot();
    expect(held.complete.has(daemon.daemonId)).toBe(true);
    expect([...(held.boards.get(daemon.daemonId)?.keys() ?? [])]).toEqual(['s']);
    expect(heard).toBe(1);
    off();
    await store.read(daemon);
    expect(heard).toBe(1);
  });

  it('shares one read among askers', async () => {
    const { calls, fetcher } = urls();
    const store = new AgendaRollupStore(fetcher);
    await Promise.all([store.read(daemon), store.read(daemon)]);
    expect(calls).toHaveLength(1);
  });

  it('keeps the last good read but stops calling it complete when a later read fails', async () => {
    let fail = false;
    const store = new AgendaRollupStore(async () => (fail ? reply({}, 500) : reply(page(['s']))));
    await store.read(daemon);
    fail = true;
    await store.read(daemon);
    const held = store.getSnapshot();
    expect(held.complete.has(daemon.daemonId)).toBe(false);
    expect(held.boards.get(daemon.daemonId)?.has('s')).toBe(true);
    await store.read(daemon);
    expect(store.getSnapshot()).toBe(held);
  });

  it('says nothing for a machine that never read', async () => {
    const store = new AgendaRollupStore(async () => reply({}, 500));
    const before = store.getSnapshot();
    await store.read(daemon);
    expect(store.getSnapshot()).toBe(before);
  });

  it('forgets a machine, and a read still in flight for it lands nowhere', async () => {
    const { fetcher } = urls();
    const store = new AgendaRollupStore(fetcher);
    await store.read(daemon);
    await store.read(other);
    store.clearDaemon(daemon.daemonId);
    expect(store.getSnapshot().boards.has(daemon.daemonId)).toBe(false);
    expect(store.getSnapshot().complete.has(daemon.daemonId)).toBe(false);
    expect(store.getSnapshot().boards.has(other.daemonId)).toBe(true);
    const unknown = store.getSnapshot();
    store.clearDaemon('nobody' as never);
    expect(store.getSnapshot()).toBe(unknown);

    const late = store.read(daemon);
    store.clearDaemon(daemon.daemonId);
    await late;
    expect(store.getSnapshot().boards.has(daemon.daemonId)).toBe(false);

    const failing = new AgendaRollupStore(async () => reply({}, 500));
    const pending = failing.read(daemon);
    failing.clearDaemon(daemon.daemonId);
    await pending;
    expect(failing.getSnapshot().complete.size).toBe(0);
  });
});
