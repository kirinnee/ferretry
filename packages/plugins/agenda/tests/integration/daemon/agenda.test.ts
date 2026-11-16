import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { AsksChanged } from '@ferretry/core-asks/contract';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
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

async function world(
  options: { access?: ReturnType<typeof access> | 'off'; conversation?: ReturnType<typeof fakeConversation> } = {},
) {
  const asks = new FakeAsks();
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1') });
  ferrets.add({ id: ferretId('f2') });
  ferrets.add({ id: ferretId('h1'), parent: ferretId('f1') });
  // The daemon half is kept so a test can hand it a hook the test host has no offerer for (`turn.ended` is Conversation's).
  const built: { half?: ReturnType<NonNullable<typeof agenda.build>> } = {};
  const implementation = {
    ...agenda,
    build: (ctx: Parameters<NonNullable<typeof agenda.build>>[0]) => {
      built.half = agenda.build?.(ctx);
      return built.half as NonNullable<typeof built.half>;
    },
  } as typeof agenda;
  const acc = options.access === 'off' ? undefined : (options.access ?? access());
  const host = await testHost({
    plugins: [implementation],
    gate: gateLikeAdmission(),
    fakes: { asks, ferrets },
    uses: {
      ...(acc === undefined ? {} : { access: acc.api }),
      ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
    },
  });
  /** A ferret's round ended: the hook's taker run, and what it started given the turns to finish. */
  const turnEnded = async (payload: unknown): Promise<void> => {
    built.half?.hooks?.['turn.ended']?.(payload as never);
    for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
    // The check waits for the transcript to settle (2 s on the driven clock) before it reads.
    await host.clock.advance(2000);
    for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { host, asks, ferrets, acc, turnEnded };
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
      { tag: 'agenda-f1:A1', title: 'Badge colour', body: 'Badge colour', url: '/ferrets/f1/chat?ask=A1' },
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
      all
        .json<{ sessions: Array<{ sessionId: string; items: unknown[] }> }>()
        .sessions.map(f => [f.sessionId, f.items.length]),
    ).toEqual([
      ['f1', 2],
      ['f2', 1],
    ]);
    const first = await host.request('GET', '/v1/agenda/open', { query: { limit: '1' }, ...as(owner()) });
    expect(first.json<{ sessions: unknown[]; next?: string }>()).toMatchObject({ next: 'f1' });
    const rest = await host.request('GET', '/v1/agenda/open', { query: { after: 'f1' }, ...as(owner()) });
    expect(rest.json<{ sessions: Array<{ sessionId: string }> }>().sessions.map(f => f.sessionId)).toEqual(['f2']);
    expect((await host.request('GET', '/v1/agenda/open', { query: { limit: '0' }, ...as(owner()) })).status).toBe(400);
  });

  test('clear-agents counts on a dry run, dismisses on a clear, reaches an auto ferret whatever its role, never an interactive one or a card’s ask, and refuses a ferret', async () => {
    const { host, asks, ferrets } = await world();
    // v4's rule is the ferret's mode, not its lineage: an autonomous lead is an agent ferret, a helper with no mode is not.
    ferrets.add({ id: ferretId('w1'), mode: 'auto' });
    ferrets.add({ id: ferretId('w2'), mode: 'auto', parent: ferretId('f1') });
    ferrets.add({ id: ferretId('w3'), mode: 'interactive' });
    await raiseAsk(asks, 'w1', 'e1');
    await raiseAsk(asks, 'w1', 'e2');
    await raiseAsk(asks, 'w1', 'e3', { source: 'card' });
    await raiseAsk(asks, 'w2', 'e4');
    await raiseAsk(asks, 'w3', 'e5');
    await raiseAsk(asks, 'h1', 'e6');
    await raiseAsk(asks, 'f1', 'e7');
    const dry = await host.request('POST', '/v1/agenda/clear-agents', { body: { dryRun: true }, ...as(owner()) });
    expect(dry.json()).toEqual({ cleared: 3, ferrets: 2 });
    expect((await asks.open({ ferret: 'w1' as never })).length).toBe(3);
    const done = await host.request('POST', '/v1/agenda/clear-agents', { body: {}, ...as(owner()) });
    expect(done.json()).toEqual({ cleared: 3, ferrets: 2 });
    expect((await asks.open({ ferret: 'w1' as never })).map(ask => String(ask.source))).toEqual(['card']);
    expect((await asks.open({ ferret: 'w2' as never })).length).toBe(0);
    for (const kept of ['w3', 'h1', 'f1']) expect((await asks.open({ ferret: kept as never })).length).toBe(1);
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
    expect(listed.json<{ items: unknown[]; resolved: unknown[] }>()).toMatchObject({ items: [{}, {}], resolved: [] });
    expect((await host.request('GET', `/v1/machine/agenda/${a.id}`, { ...as(owner()) })).json()).toMatchObject({
      subject: 'Disk almost full',
    });
    expect((await host.request('GET', '/v1/machine/agenda/A99', { ...as(owner()) })).status).toBe(404);
    const dismissed = await host.request('POST', '/v1/machine/agenda', {
      body: { action: 'dismiss', id: a.id },
      ...as(owner()),
    });
    expect(dismissed.json<{ items: unknown[]; resolved: unknown[] }>()).toMatchObject({ items: [{}], resolved: [{}] });
    const snooze = await host.request('POST', '/v1/machine/agenda', {
      body: { action: 'snooze', id: 'A2', until: '2026-11-08T09:00:00.000Z' },
      ...as(owner()),
    });
    expect(snooze.status).toBe(400);
    expect(JSON.stringify(snooze.json())).toContain('a notice is read, not snoozed');
    expect(
      (await host.request('POST', '/v1/machine/agenda', { body: { action: 'dismiss', id: 'nope' }, ...as(owner()) }))
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

describe('the turn-end check', () => {
  const ASKING = [
    { kind: 'message', role: 'user', text: 'ship it' },
    { kind: 'message', role: 'assistant', text: 'Shipped.\n\n## Waiting on you\n- Approve the release\n' },
  ] as never;
  const ended = (ferret: string, outcome: 'completed' | 'interrupted' | 'failed' = 'completed') => ({
    ferret: ferretId(ferret),
    turn: 't1',
    outcome,
    endedAt: '2026-11-15T00:00:00.000Z' as never,
  });
  async function checked() {
    const conversation = fakeConversation();
    for (const ferret of ['f1', 'f2', 'h1']) conversation.setEvents(ferretId(ferret), ASKING);
    return { ...(await world({ conversation })), conversation };
  }
  const sentTo = async (conversation: ReturnType<typeof fakeConversation>, ferret: string) =>
    (await conversation.sends(ferretId(ferret))).sends;

  test('a ferret whose finished reply asks the owner for something it did not raise gets ONE nudge, as the daemon’s own words', async () => {
    const { turnEnded, conversation } = await checked();
    await turnEnded(ended('f1'));
    await turnEnded(ended('f1'));
    const sends = await sentTo(conversation, 'f1');
    expect(sends.map(send => [send.sendId.replace(/-[0-9a-f]{16}-/u, '-DIGEST-'), send.senderKind])).toEqual([
      ['attention-nudge-f1-DIGEST-0', 'daemon'],
    ]);
    expect(sends[0]?.message).toContain('[attention check]');
    expect(sends[0]?.message).toContain('- Approve the release');
  });

  test('a ferret is nudged once until another sender reaches it, then it may be nudged again', async () => {
    let at = '2026-11-06T09:00:00.000Z';
    const conversation = fakeConversation({ now: () => at as never });
    conversation.setEvents(ferretId('f1'), ASKING);
    const { turnEnded } = await world({ conversation });
    await turnEnded(ended('f1'));
    await turnEnded({ ...ended('f1'), turn: 't2' });
    expect(await sentTo(conversation, 'f1')).toHaveLength(1);
    at = '2026-11-06T10:00:00.000Z';
    await conversation.send(ferretId('f1'), { kind: 'owner' }, { message: 'go ahead', sendId: 'owner-1' });
    await turnEnded({ ...ended('f1'), turn: 't3' });
    expect((await sentTo(conversation, 'f1')).map(send => send.senderKind)).toEqual(['daemon', 'human', 'daemon']);
  });

  test('an interrupted or failed round, a helper and a stopped ferret are not nudged', async () => {
    const { turnEnded, conversation, ferrets } = await checked();
    ferrets.add({ id: ferretId('f2'), state: 'stopped' });
    await turnEnded(ended('f1', 'interrupted'));
    await turnEnded(ended('f1', 'failed'));
    await turnEnded(ended('h1'));
    await turnEnded(ended('f2'));
    for (const ferret of ['f1', 'f2', 'h1']) expect(await sentTo(conversation, ferret)).toEqual([]);
  });

  test('says nothing, and breaks nothing, when Conversation is off', async () => {
    const { turnEnded } = await world();
    await turnEnded(ended('f1'));
  });
});

describe('the rest nudge job', () => {
  const resting = (id: string, ferret: string) => ({
    id,
    subject: `Ask ${id}?`,
    title: `Ask ${id}`,
    source: 'agent-raised',
    sourceRef: null,
    raisedBy: 'agent',
    parked: { reason: 'replied', at: '2020-01-01T00:00:00.000Z' },
    resting: { sub: 'waiting-on-ferret', at: '2020-01-01T00:00:00.000Z' },
    ferret,
  });
  async function silent(ferrets: readonly string[] = ['f1']) {
    const conversation = fakeConversation();
    const w = await world({ conversation });
    w.asks.snapshots = async () =>
      ferrets.map(ferret => ({ sessionId: ferret, items: [resting('A1', ferret)] })) as never;
    return { ...w, conversation };
  }
  const sentTo = async (conversation: ReturnType<typeof fakeConversation>, ferret: string) =>
    (await conversation.sends(ferretId(ferret))).sends;

  test('is a job; a ferret silent on an item the owner replied to is nudged once as the daemon’s own words, then waits for the backoff', async () => {
    const { host, conversation } = await silent();
    expect(host.jobIds()).toContain('rest-nudge');

    await host.runJob('rest-nudge');
    await host.runJob('rest-nudge');

    const sends = await sentTo(conversation, 'f1');
    expect(sends.map(send => [send.sendId.startsWith('agenda-rest-nudge-f1-A1.'), send.senderKind])).toEqual([
      [true, 'daemon'],
    ]);
    expect(sends[0]?.message).toContain('[attention check] The owner replied on !A1 «Ask A1»');
  });

  test('never reaches a stopped ferret, and says nothing, and breaks nothing, when Conversation is off', async () => {
    const { host, conversation, ferrets } = await silent(['f1', 'f2']);
    ferrets.add({ id: ferretId('f2'), state: 'stopped' });

    await host.runJob('rest-nudge');

    expect(await sentTo(conversation, 'f1')).toHaveLength(1);
    expect(await sentTo(conversation, 'f2')).toEqual([]);

    const off = await world();
    off.asks.snapshots = async () => [{ sessionId: 'f1', items: [resting('A1', 'f1')] }] as never;
    await off.host.runJob('rest-nudge');
  });

  test('boards that cannot be read fail the sweep, which the kernel reports and retries', async () => {
    const { host, asks } = await silent();
    asks.snapshots = async () => {
      throw new Error('the board is damaged');
    };

    await expect(host.runJob('rest-nudge')).rejects.toThrow('the board is damaged');
  });

  describe('forgetting counters', () => {
    const counter = { since: '2020-01-01T00:00:00.000Z', nudges: 2, at: '2020-01-01T01:00:00.000Z', sendId: 's1' };
    const stored = (host: { state(name: string): { files: Map<string, string> } }) =>
      JSON.parse(host.state('agenda').files.get('rest-nudges.json') ?? '{"ferrets":{}}').ferrets as Record<
        string,
        Record<string, unknown>
      >;

    test('closing the last nudged item drops its record on the next sweep, with no ferret nudged', async () => {
      const { host, asks, conversation } = await silent();
      await host.runJob('rest-nudge');
      expect(Object.keys(stored(host))).toEqual(['f1']);

      asks.snapshots = async () => [{ sessionId: 'f1', items: [] }] as never;
      await host.runJob('rest-nudge');

      expect(stored(host)).toEqual({});
      expect(await sentTo(conversation, 'f1')).toHaveLength(1);
    });

    test('a ferret that is gone loses its records, and one whose board could not be read keeps them', async () => {
      const { host, asks } = await silent();
      host
        .state('agenda')
        .files.set(
          'rest-nudges.json',
          JSON.stringify({ format: 1, ferrets: { f1: { A1: counter }, f9: { A1: counter } } }),
        );

      asks.snapshots = async () => [] as never;
      await host.runJob('rest-nudge');

      expect(Object.keys(stored(host))).toEqual(['f1']);
    });

    test('an unchanged file is not rewritten by a sweep', async () => {
      const { host, asks } = await silent();
      asks.snapshots = async () => [{ sessionId: 'f1', items: [resting('A1', 'f1')] }] as never;
      const text = JSON.stringify({
        format: 1,
        ferrets: { f1: { A1: { ...counter, at: new Date(host.clock.now()).toISOString(), sendId: 'planted' } } },
      });
      host.state('agenda').files.set('rest-nudges.json', text);

      await host.runJob('rest-nudge');

      expect(host.state('agenda').files.get('rest-nudges.json')).toBe(text);
    });
  });
});
