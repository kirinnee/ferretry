import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { AsksChanged } from '@ferretry/core-asks/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { owner, type TestCaller, testHost } from '@ferretry/kernel/testing';
import { as, gateLikeAdmission } from '../../support/gate.ts';
import { type AgendaApi, AgendaPort } from '../../../contract/index.ts';
import { agendaConformance } from '../../../contract/testing/index.ts';
import type { AccessBuzzApi } from '../../../contract/others.ts';
import agenda from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';
import { raiseAsk } from '../../unit/daemon/support.ts';

const SEEN_BODY = { sessionId: 'f1', agendaId: 'A1' };
const fleetUse = { kind: 'device', holder: 'dev_a', capabilities: ['fleet.use'] } as const;
const noFleet = { kind: 'device', holder: 'dev_a', capabilities: ['pairing.use'] } as const;

function access() {
  const buzzed: Array<Parameters<AccessBuzzApi['buzz']>[0]> = [];
  const cleared: Array<{ tags: readonly string[]; except: string | undefined }> = [];
  const api: AccessBuzzApi = {
    buzz: async message => {
      buzzed.push(message);
      return 1;
    },
    clear: async (tags, except) => {
      cleared.push({ tags, except });
      return 1;
    },
  };
  return { api, buzzed, cleared };
}

async function world(options: { access?: ReturnType<typeof access> | 'off' } = {}) {
  const asks = new FakeAsks();
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1') });
  ferrets.add({ id: ferretId('f2') });
  ferrets.add({ id: ferretId('h1'), parent: ferretId('f1') });
  const acc = options.access === 'off' ? undefined : (options.access ?? access());
  const host = await testHost({
    plugins: [agenda],
    gate: gateLikeAdmission(),
    fakes: { asks, ferrets },
    ...(acc === undefined ? {} : { uses: { access: acc.api } }),
  });
  return { host, asks, ferrets, acc };
}

describe('POST /v1/push/seen', () => {
  async function buzzedCard() {
    const w = await world();
    const ref = await raiseAsk(w.asks, 'f1', 'e1', { source: 'card', subject: 'Badge colour is at Released' });
    w.host.emit(AsksChanged, { ferret: 'f1', askId: ref.id, state: 'open' });
    await w.host.settle();
    return { ...w, ref };
  }

  test('G167 skips the device that opened it, read from its credential and never the body, and answers only the tags', async () => {
    const { host, acc } = await buzzedCard();
    expect(acc?.buzzed).toHaveLength(1);
    const response = await host.request('POST', '/v1/push/seen', { body: SEEN_BODY, ...as(fleetUse) });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ cleared: true, tags: ['agenda-f1:A1'] });
    expect(acc?.cleared).toEqual([{ tags: ['agenda-f1:A1'], except: 'dev_a' }]);
    // The body carries no item words, no endpoint: only the tags come back.
    expect(response.body).not.toContain('Badge');
  });

  test('G167 skips no device for the owner at the machine, and says when nothing was still up', async () => {
    const w = await world();
    await raiseAsk(w.asks, 'f1', 'e1');
    const response = await w.host.request('POST', '/v1/push/seen', { body: SEEN_BODY, ...as(owner()) });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ cleared: false, tags: [] });
    expect(w.acc?.cleared).toEqual([]);
  });

  test('answers 404 for an ask that is not on that board', async () => {
    const { host } = await world();
    const response = await host.request('POST', '/v1/push/seen', { body: SEEN_BODY, ...as(fleetUse) });
    expect(response.status).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('push_not_found');
  });

  test('G167 refuses a body that names more than the ask, before anything is cleared', async () => {
    const { host, acc } = await buzzedCard();
    for (const body of [
      { ...SEEN_BODY, exceptDevice: 'dev_b' },
      { sessionId: 'f1', agendaId: 'not-an-id' },
    ])
      expect((await host.request('POST', '/v1/push/seen', { body, ...as(fleetUse) })).status).toBe(400);
    expect(acc?.cleared).toEqual([]);
  });

  test('G167 is fleet.use for a person: a device narrowed off the fleet is refused, and a ferret is refused', async () => {
    const route = manifest.actions.routes.find(candidate => candidate.key === 'POST /v1/push/seen');
    expect(route?.capability).toMatchObject({ axis: 'use' });
    expect(String(route?.capability?.capability)).toBe('fleet');
    expect(route?.caller).toBe('person');
    const { host } = await buzzedCard();
    expect((await host.request('POST', '/v1/push/seen', { body: SEEN_BODY, ...as(noFleet) })).status).toBe(403);
    expect(
      (await host.request('POST', '/v1/push/seen', { body: SEEN_BODY, ...as({ kind: 'ferret', id: 'f1' }) })).status,
    ).toBe(403);
  });

  test('records the ask as seen even when Access cannot take other devices’ lines down', async () => {
    const w = await world({ access: 'off' });
    await raiseAsk(w.asks, 'f1', 'e1');
    const response = await w.host.request('POST', '/v1/push/seen', { body: SEEN_BODY, ...as(owner()) });
    expect(response.status).toBe(200);
    const stored = JSON.parse(w.host.state('agenda').files.get('seen.json') ?? '{}') as {
      seen: Record<string, Record<string, string>>;
    };
    expect(stored.seen.f1?.A1).toBeDefined();
  });
});

describe('buzzes', () => {
  test('a card’s ask buzzes once, however often it is announced', async () => {
    const { host, asks, acc } = await world();
    const ref = await raiseAsk(asks, 'f1', 'e1', { source: 'card', subject: 'Badge colour' });
    for (let i = 0; i < 3; i++) host.emit(AsksChanged, { ferret: 'f1', askId: ref.id, state: 'open' });
    await host.settle();
    expect(acc?.buzzed).toEqual([
      { tag: 'agenda-f1:A1', title: 'Badge colour', body: 'Badge colour', url: '/agenda/f1/A1' },
    ]);
    expect(host.published.filter(each => each.event === 'agenda.buzzed')).toHaveLength(1);
  });

  test('an ordinary ask does not buzz when raised; a closed one never does', async () => {
    const { host, asks, acc } = await world();
    const plain = await raiseAsk(asks, 'f1', 'e1');
    host.emit(AsksChanged, { ferret: 'f1', askId: plain.id, state: 'open' });
    await asks.close(plain, 'dismissed');
    host.emit(AsksChanged, { ferret: 'f1', askId: plain.id, state: 'closed' });
    await host.settle();
    expect(acc?.buzzed).toEqual([]);
  });

  test('the port buzzes once per key and kind, for a moment another plugin names', async () => {
    const { host, acc } = await world();
    const port = host.provided(AgendaPort);
    expect(await port.buzz('deadline:f1:A2', 'deadline', { title: 'Due soon', body: 'Needed in 25 min' })).toBe(true);
    expect(await port.buzz('deadline:f1:A2', 'deadline', { title: 'Due soon', body: 'Needed in 25 min' })).toBe(false);
    expect(acc?.buzzed).toHaveLength(1);
    expect(host.state('agenda').files.get('buzzes.jsonl')).toContain('deadline:f1:A2');
  });
});

describe('the roll-up and clearing', () => {
  test('lists every ferret’s open asks in ferret order, paged without splitting a ferret', async () => {
    const { host, asks } = await world();
    await raiseAsk(asks, 'f2', 'e1');
    await raiseAsk(asks, 'f1', 'e2');
    await raiseAsk(asks, 'f1', 'e3');
    const all = await host.request('GET', '/v1/agenda/open', { ...as(owner()) });
    expect(
      all.json<{ ferrets: Array<{ ferret: string; asks: unknown[] }> }>().ferrets.map(f => [f.ferret, f.asks.length]),
    ).toEqual([
      ['f1', 2],
      ['f2', 1],
    ]);
    const first = await host.request('GET', '/v1/agenda/open', { query: { limit: '1' }, ...as(owner()) });
    expect(first.json<{ ferrets: unknown[]; next?: string }>()).toMatchObject({ next: 'f1' });
    const rest = await host.request('GET', '/v1/agenda/open', { query: { after: 'f1' }, ...as(owner()) });
    expect(rest.json<{ ferrets: Array<{ ferret: string }> }>().ferrets.map(f => f.ferret)).toEqual(['f2']);
    expect((await host.request('GET', '/v1/agenda/open', { query: { limit: '0' }, ...as(owner()) })).status).toBe(400);
  });

  test('clear-agents counts on a dry run, dismisses on a clear, never touches a lead or a card’s ask, and refuses a ferret', async () => {
    const { host, asks } = await world();
    await raiseAsk(asks, 'h1', 'e1');
    await raiseAsk(asks, 'h1', 'e2');
    await raiseAsk(asks, 'h1', 'e3', { source: 'card' });
    await raiseAsk(asks, 'f1', 'e4');
    const dry = await host.request('POST', '/v1/agenda/clear-agents', { body: { dryRun: true }, ...as(owner()) });
    expect(dry.json()).toEqual({ cleared: 2, ferrets: 1 });
    expect((await asks.open({ ferret: 'h1' as never })).length).toBe(3);
    const done = await host.request('POST', '/v1/agenda/clear-agents', { body: {}, ...as(owner()) });
    expect(done.json()).toEqual({ cleared: 2, ferrets: 1 });
    expect((await asks.open({ ferret: 'h1' as never })).map(ask => String(ask.source))).toEqual(['card']);
    expect((await asks.open({ ferret: 'f1' as never })).length).toBe(1);
    expect(
      (await host.request('POST', '/v1/agenda/clear-agents', { body: {}, ...as({ kind: 'ferret', id: 'f1' }) })).status,
    ).toBe(403);
  });
});

describe('agenda mode', () => {
  test('G43 a ferret switches only its own mode (a lead also its helpers’); the owner switches any', async () => {
    const { host } = await world();
    const patch = (id: string, caller: TestCaller) =>
      host.request('PATCH', `/v1/ferrets/${id}/agenda-mode`, { body: { enabled: true }, ...as(caller) });
    expect((await patch('f1', { kind: 'ferret', id: 'f1' })).status).toBe(200);
    expect((await patch('h1', { kind: 'ferret', id: 'f1' })).status).toBe(200);
    expect((await patch('f2', { kind: 'ferret', id: 'f1' })).status).toBe(403);
    expect((await patch('f1', { kind: 'ferret', id: 'h1' })).status).toBe(403);
    expect((await patch('f2', owner())).status).toBe(200);
    expect(
      (await host.request('GET', '/v1/ferrets/f2/agenda-mode', { ...as({ kind: 'ferret', id: 'f1' }) })).status,
    ).toBe(403);
  });

  test('reads on for a ferret that recorded nothing (the machine default), says a running ferret needs a restart, and refuses an unknown ferret', async () => {
    const { host } = await world();
    expect((await host.request('GET', '/v1/ferrets/f1/agenda-mode', { ...as(owner()) })).json()).toEqual({
      enabled: true,
      restartRequired: false,
      note: 'Agenda mode is on.',
    });
    const switched = await host.request('PATCH', '/v1/ferrets/f1/agenda-mode', {
      body: { enabled: false },
      ...as(owner()),
    });
    expect(switched.json()).toMatchObject({ ferret: 'f1', enabled: false, restartRequired: true });
    expect(
      (await host.request('GET', '/v1/ferrets/f1/agenda-mode', { ...as(owner()) })).json<{ enabled: boolean }>()
        .enabled,
    ).toBe(false);
    expect(host.published.some(each => each.event === 'agenda.mode-changed')).toBe(true);
    expect((await host.request('GET', '/v1/ferrets/ghost/agenda-mode', { ...as(owner()) })).status).toBe(404);
    expect(
      (await host.request('PATCH', '/v1/ferrets/f1/agenda-mode', { body: { enabled: 'yes' }, ...as(owner()) })).status,
    ).toBe(400);
  });
});

describe('the daemon agenda', () => {
  const MACHINE = 'machine-agenda';
  test('lists open and resolved notices, reads one, and lets the owner dismiss or resolve; snooze is refused in words', async () => {
    const { host, asks } = await world();
    const a = await raiseAsk(asks, MACHINE, 'e1', { kind: 'notice', subject: 'Disk almost full' });
    await raiseAsk(asks, MACHINE, 'e2', { kind: 'notice', subject: 'Update ready' });
    const listed = await host.request('GET', '/v1/machine/agenda', { ...as(owner()) });
    expect(listed.json<{ asks: unknown[]; resolved: unknown[] }>()).toMatchObject({ asks: [{}, {}], resolved: [] });
    expect((await host.request('GET', `/v1/machine/agenda/${a.id}`, { ...as(owner()) })).json()).toMatchObject({
      subject: 'Disk almost full',
    });
    expect((await host.request('GET', '/v1/machine/agenda/A99', { ...as(owner()) })).status).toBe(404);
    const dismissed = await host.request('POST', '/v1/machine/agenda', {
      body: { action: 'dismiss', ask: a.id },
      ...as(owner()),
    });
    expect(dismissed.json<{ asks: unknown[]; resolved: unknown[] }>()).toMatchObject({ asks: [{}], resolved: [{}] });
    const snooze = await host.request('POST', '/v1/machine/agenda', {
      body: { action: 'snooze', ask: 'A2', until: '2026-11-08T09:00:00.000Z' },
      as: owner(),
    });
    expect(snooze.status).toBe(501);
    expect(
      (await host.request('POST', '/v1/machine/agenda', { body: { action: 'dismiss', ask: 'nope' }, ...as(owner()) }))
        .status,
    ).toBe(400);
    expect((await host.request('GET', '/v1/machine/agenda', { ...as({ kind: 'ferret', id: 'f1' }) })).status).toBe(403);
  });
});

/** The real half behind the synchronous `make` the conformance suite wants: each call waits for the host. */
function lazyAgenda(): AgendaApi {
  const ready = world().then(w => w.host.provided(AgendaPort));
  return {
    open: async query => (await ready).open(query),
    daemonAgenda: async () => (await ready).daemonAgenda(),
    mode: async ferret => (await ready).mode(ferret),
    setMode: async (ferret, enabled) => (await ready).setMode(ferret, enabled),
    clearAgents: async options => (await ready).clearAgents(options),
    buzz: async (key, kind, message) => (await ready).buzz(key, kind, message),
  };
}

agendaConformance('daemon half', lazyAgenda);
