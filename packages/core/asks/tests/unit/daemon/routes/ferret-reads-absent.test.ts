import { describe, expect, test } from 'bun:test';
import type { ApiResponse } from '@ferretry/kernel/contract';
import { type AgendaLedger, AgendaService } from '../../../../daemon/lib/agenda/index.ts';
import type { AgendaVersionStore } from '../../../../daemon/lib/agenda/versions.ts';
import type { FerretReach } from '../../../../daemon/lib/routes/ferret-reads.ts';
import { agendaRoutes } from '../../../../daemon/lib/routes/agenda.ts';
import { agentIn, device, FakeLedgerRepository, human, NO_HELD_REPLIES, routeDispatcher } from './support.ts';

/**
 * Audit A fix 8: for a FERRET caller a Warden item the projection omits (one of another lineage) answers exactly as an id
 * that was never raised, on every Asks read route: the same status, the same body (the id echoed back aside) and the same
 * headers. The board's `updatedAt` is recomputed from what the ferret can read, so an omitted item never moves it.
 *
 * The routes are the real handlers over a real `AgendaService`; the ledger is in memory and the version store is a fake that
 * holds, for the cold case, an item that has left the board. The Warden items are in the grammars a live daemon writes
 * (`ask:daemon:f.<ferret>.warden:…`) AND the raw v4 grammar a migrated home keeps (`warden:…`, `warden-…`).
 */

const AT = '2026-11-06T09:00:00.000Z';
const LATER = '2026-11-06T22:00:00.000Z';
const W_REASON = 'FIXTURE investigator reason';
const W_CONTEXT = 'FIXTURE investigator context';
const W_REMEDY = 'FIXTURE investigator remedy';
const W_REPLY = 'FIXTURE owner reply';
const W_COLD = 'FIXTURE cold archived words';
const WORDS = [W_REASON, W_CONTEXT, W_REMEDY, W_REPLY, W_COLD];

const base = {
  source: 'question' as const,
  why: W_REASON,
  context: W_CONTEXT,
  howToResolve: W_REMEDY,
  waitingSince: AT,
  raisedBySession: null,
  raisedByName: null,
};
const wardenItem = (id: string, sourceRef: string, extra: Record<string, unknown> = {}) => ({
  ...base,
  id,
  sourceRef,
  subject: `Warden notice ${id}`,
  raisedBy: 'daemon' as const,
  ...extra,
});
const plainItem = (id: string) => ({
  ...base,
  id,
  sourceRef: null,
  subject: `Plain ask ${id}`,
  why: 'A plain reason',
  context: null,
  howToResolve: 'A plain remedy',
  raisedBy: 'agent' as const,
});
const closed = {
  resolvedAt: AT,
  resolvedBy: 'human' as const,
  resolvedBySession: null,
  resolvedByName: null,
  disposition: 'done' as const,
};
const OWNER_REPLY = [
  { by: 'ferret', at: AT, text: 'FIXTURE ferret words', via: 'discuss' },
  { by: 'owner', at: AT, text: W_REPLY, via: 'reply' },
];
const COLD_THREAD = [{ by: 'owner', at: AT, text: W_COLD, via: 'reply' }];

/** `stranger` is not in `lead`'s lineage; `helper` is. */
const reach: FerretReach = {
  mayTouch: async (caller, target) => caller === target || (caller === 'lead' && target === 'helper'),
  startedByWarden: async ferret => ferret === 'investigator',
};

const HIDDEN_BOARD = 'stranger';
/** Hidden from `lead` on `stranger`'s board, in each grammar and lifecycle. */
const HIDDEN = {
  live: 'A2',
  rawV4: 'A3',
  resolved: 'A4',
  cold: 'A9',
} as const;

const ledgerOf = (withWarden: boolean, updatedAt: string): AgendaLedger =>
  ({
    sessionId: HIDDEN_BOARD,
    nextId: 10,
    updatedAt,
    version: 1,
    conversations: { A2: OWNER_REPLY },
    entries: [
      { lifecycle: 'active', origin: { kind: 'agent', sessionId: HIDDEN_BOARD, name: null }, item: plainItem('A1') },
      ...(withWarden
        ? [
            {
              lifecycle: 'active',
              origin: { kind: 'daemon', cause: 'warden-escalation' },
              item: wardenItem('A2', 'ask:daemon:f.stranger.warden:ask:sus_thinking'),
            },
            {
              lifecycle: 'active',
              origin: { kind: 'daemon', cause: 'warden-escalation' },
              item: wardenItem('A3', 'warden:orphans', { waitingSince: LATER }),
            },
            {
              lifecycle: 'addressed',
              origin: { kind: 'daemon', cause: 'warden-escalation' },
              item: { ...wardenItem('A4', 'warden-auto-move'), ...closed, resolvedAt: LATER },
            },
          ]
        : []),
    ],
  }) as unknown as AgendaLedger;

const summary = (version: number) => ({
  version,
  at: AT,
  by: 'daemon' as const,
  change: 'created',
  lifecycle: 'active' as const,
});
/** The versions kept of each hidden item; A9 has left the board and only its versions remain. */
const versions: AgendaVersionStore = {
  record: async () => undefined,
  list: async (_session, id) => (Object.values(HIDDEN).includes(id as never) ? [summary(1)] : []),
  get: async (_session, id, version) =>
    version === 1 && Object.values(HIDDEN).includes(id as never)
      ? ({ ...summary(1), item: wardenItem(id, id === 'A9' ? 'ask:daemon:warden.orphans' : 'warden:orphans') } as never)
      : undefined,
  conversation: async (_session, id, version) => (id === 'A9' && version === 1 ? (COLD_THREAD as never) : undefined),
};

const world = (withWarden = true, updatedAt = LATER) => {
  const service = new AgendaService(
    new FakeLedgerRepository(ledgerOf(withWarden, updatedAt)),
    { now: () => '2030-01-01T00:00:00.000Z' },
    { has: async id => id === HIDDEN_BOARD },
    { raised: async () => undefined },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    versions,
  );
  const dispatch = routeDispatcher(
    agendaRoutes(service, NO_HELD_REPLIES, { enrolledDevices: async () => 0 }, undefined, undefined, undefined, reach),
  );
  return {
    get: (path: string, caller = agentIn('lead'), query: readonly (readonly [string, string])[] = []) =>
      dispatch({ path, headers: caller, query }),
  };
};

const READS = (id: string): readonly (readonly [string, string, readonly (readonly [string, string])[]])[] => [
  ['item', `/v1/ferrets/${HIDDEN_BOARD}/agenda/${id}`, []],
  ['versions list', `/v1/ferrets/${HIDDEN_BOARD}/agenda/${id}/versions`, []],
  ['version 1', `/v1/ferrets/${HIDDEN_BOARD}/agenda/${id}/versions/1`, []],
  ['version 7', `/v1/ferrets/${HIDDEN_BOARD}/agenda/${id}/versions/7`, []],
  ['conversation', `/v1/ferrets/${HIDDEN_BOARD}/agenda/${id}/conversation`, []],
  ['conversation fragment 1', `/v1/ferrets/${HIDDEN_BOARD}/agenda/${id}/conversation`, [['index', '1']]],
  ['conversation of version 1', `/v1/ferrets/${HIDDEN_BOARD}/agenda/${id}/conversation`, [['version', '1']]],
  ['conversation of version 7', `/v1/ferrets/${HIDDEN_BOARD}/agenda/${id}/conversation`, [['version', '7']]],
];

/** The answer with the id it echoes made one thing, so a hidden id and an absent id can be compared byte for byte. */
const shape = (response: ApiResponse, id: string) => ({
  status: response.status,
  body: response.body.replaceAll(id, '<ID>'),
  headers: [...response.headers].map(([key, value]) => [key, value.replaceAll(id, '<ID>')]).sort(),
});

describe('a hidden Warden item answers exactly like an id that never existed', () => {
  for (const [kind, hidden] of Object.entries(HIDDEN)) {
    test.each(READS(hidden).map(([name, path, query]) => [name, path, query] as const))(
      `${kind} item ${hidden}: %s`,
      async (_name, path, query) => {
        const w = world();
        const absentId = 'A77';
        const absentPath = path.replace(`/agenda/${hidden}`, `/agenda/${absentId}`);
        const hiddenAnswer = await w.get(path, agentIn('lead'), query);
        const absentAnswer = await w.get(absentPath, agentIn('lead'), query);
        expect(shape(hiddenAnswer, hidden)).toEqual(shape(absentAnswer, absentId));
        for (const words of WORDS) expect(hiddenAnswer.body).not.toContain(words);
      },
    );
  }

  test('the absent answers are the ones the routes always gave (the reference is unchanged)', async () => {
    const w = world();
    expect((await w.get(`/v1/ferrets/${HIDDEN_BOARD}/agenda/A77`)).status).toBe(404);
    const list = await w.get(`/v1/ferrets/${HIDDEN_BOARD}/agenda/A77/versions`);
    expect([list.status, JSON.parse(list.body)]).toEqual([
      200,
      { sessionId: HIDDEN_BOARD, id: 'A77', latest: 0, versions: [] },
    ]);
    expect((await w.get(`/v1/ferrets/${HIDDEN_BOARD}/agenda/A77/versions/1`)).status).toBe(404);
    expect((await w.get(`/v1/ferrets/${HIDDEN_BOARD}/agenda/A77/conversation`)).status).toBe(404);
  });
});

describe('what a ferret of the right lineage reads of the same items', () => {
  test('its own lineage’s Warden items read as fixed sentences on every route, archived thread included', async () => {
    const w = world();
    // `lead` reaches `helper`: the same items, on a board whose notices name helper, are projected, not omitted.
    const mine = new AgendaService(
      new FakeLedgerRepository({
        ...ledgerOf(true, LATER),
        entries: [
          ...ledgerOf(true, LATER).entries.map(entry =>
            entry.item.id === 'A2'
              ? { ...entry, item: { ...entry.item, sourceRef: 'ask:daemon:f.helper.warden:ask:sus_thinking' } }
              : entry,
          ),
        ],
      } as AgendaLedger),
      { now: () => AT },
      { has: async id => id === HIDDEN_BOARD },
      { raised: async () => undefined },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      versions,
    );
    const dispatch = routeDispatcher(
      agendaRoutes(mine, NO_HELD_REPLIES, { enrolledDevices: async () => 0 }, undefined, undefined, undefined, reach),
    );
    for (const [name, path, query] of READS('A2').filter(([name]) => !name.endsWith('7'))) {
      const read = await dispatch({ path, headers: agentIn('lead'), query });
      expect([name, read.status]).toEqual([name, 200]);
      for (const words of WORDS) expect(read.body).not.toContain(words);
    }
    void w;
  });
});

describe('a board and its updatedAt as a ferret reads it', () => {
  test('an omitted item never moves updatedAt, count or order', async () => {
    const withHidden = await world(true, LATER).get(`/v1/ferrets/${HIDDEN_BOARD}/agenda`);
    const without = await world(false, AT).get(`/v1/ferrets/${HIDDEN_BOARD}/agenda`);
    expect(withHidden.status).toBe(200);
    expect(shape(withHidden, 'x')).toEqual(shape(without, 'x'));
    const board = JSON.parse(withHidden.body) as { count: number; updatedAt: string; items: { id: string }[] };
    expect(board.items.map(item => item.id)).toEqual(['A1']);
    expect(board.count).toBe(1);
    expect(board.updatedAt).toBe(AT);
  });

  test('a board with nothing the ferret may read answers what an empty board answers', async () => {
    const service = new AgendaService(
      new FakeLedgerRepository({
        ...ledgerOf(true, LATER),
        entries: ledgerOf(true, LATER).entries.slice(1),
      } as AgendaLedger),
      { now: () => '2030-01-01T00:00:00.000Z' },
      { has: async id => id === HIDDEN_BOARD },
      { raised: async () => undefined },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      versions,
    );
    const dispatch = routeDispatcher(
      agendaRoutes(
        service,
        NO_HELD_REPLIES,
        { enrolledDevices: async () => 0 },
        undefined,
        undefined,
        undefined,
        reach,
      ),
    );
    const board = JSON.parse(
      (await dispatch({ path: `/v1/ferrets/${HIDDEN_BOARD}/agenda`, headers: agentIn('lead') })).body,
    ) as { count: number; updatedAt: string };
    expect(board.count).toBe(0);
    expect(board.updatedAt).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('the owner and a device read everything, as before', () => {
  test.each([
    ['owner', human],
    ['device', device('phone')],
  ] as const)('%s: every route answers the whole item', async (_who, caller) => {
    const w = world();
    const board = await w.get(`/v1/ferrets/${HIDDEN_BOARD}/agenda`, caller);
    const parsed = JSON.parse(board.body) as {
      count: number;
      updatedAt: string;
      items: { id: string; sourceRef: string | null; why: string }[];
    };
    expect(parsed.items.map(item => item.id)).toEqual(['A1', 'A2', 'A3']);
    expect(parsed.count).toBe(3);
    expect(parsed.updatedAt).toBe(LATER);
    expect(parsed.items[1]).toMatchObject({
      sourceRef: 'ask:daemon:f.stranger.warden:ask:sus_thinking',
      why: W_REASON,
    });
    const item = await w.get(`/v1/ferrets/${HIDDEN_BOARD}/agenda/A3`, caller);
    expect(item.body).toBe(JSON.stringify(parsed.items[2]));
    const conversation = await w.get(`/v1/ferrets/${HIDDEN_BOARD}/agenda/A2/conversation`, caller, [['index', '1']]);
    expect(conversation.body).toContain(W_REPLY);
    const cold = await w.get(`/v1/ferrets/${HIDDEN_BOARD}/agenda/A9/conversation`, caller);
    expect(cold.body).toContain(W_COLD);
    expect((await w.get(`/v1/ferrets/${HIDDEN_BOARD}/agenda/A9/versions/1`, caller)).body).toContain(
      '"sourceRef":"ask:daemon:warden.orphans"',
    );
  });
});

/**
 * Warden provenance is sticky: a merge keeps the survivor's own provenance but copies the absorbed item's words in, and a
 * split starts an item from an old one, so an item counts as the Warden's when anything merged into it, or the item it was
 * split from, is. The investigator below is a session the Warden started.
 */
describe('provenance survives a merge and a split', () => {
  const byInvestigator = (id: string, extra: Record<string, unknown> = {}) => ({
    ...plainItem(id),
    subject: `Investigator ask ${id}`,
    raisedBySession: 'investigator',
    ...extra,
  });
  const active = (item: unknown) => ({
    lifecycle: 'active',
    origin: { kind: 'agent', sessionId: HIDDEN_BOARD, name: null },
    item,
  });
  const addressed = (item: unknown) => ({
    lifecycle: 'addressed',
    origin: { kind: 'agent', sessionId: 'investigator', name: null },
    item: { ...(item as object), ...closed },
  });
  const merged = (id: string, from: string[], extra: Record<string, unknown> = {}) => ({
    ...plainItem(id),
    mergedFrom: from,
    conversation: [{ by: 'ferret', at: AT, text: W_REPLY, via: 'discuss' }],
    ...extra,
  });

  const sticky = (entries: unknown[], kept: Record<string, unknown> = {}) => {
    const store: AgendaVersionStore = {
      record: async () => undefined,
      list: async (_session, id) => (id in kept ? [summary(1)] : []),
      get: async (_session, id, version) =>
        version === 1 && id in kept ? ({ ...summary(1), item: kept[id] } as never) : undefined,
    };
    const service = new AgendaService(
      new FakeLedgerRepository({
        sessionId: HIDDEN_BOARD,
        nextId: 20,
        updatedAt: AT,
        version: 1,
        entries,
      } as unknown as AgendaLedger),
      { now: () => AT },
      { has: async id => id === HIDDEN_BOARD },
      { raised: async () => undefined },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );
    const dispatch = routeDispatcher(
      agendaRoutes(
        service,
        NO_HELD_REPLIES,
        { enrolledDevices: async () => 0 },
        undefined,
        undefined,
        undefined,
        reach,
      ),
    );
    return (path: string, caller = agentIn('lead')) => dispatch({ path, headers: caller });
  };

  const CASES: readonly [string, () => ReturnType<typeof sticky>, string][] = [
    [
      'an investigator’s thread merged into a plain item (the absorbed item still on the board)',
      () => sticky([active(merged('A1', ['A2'])), addressed(byInvestigator('A2', { mergedInto: 'A1' }))]),
      'A1',
    ],
    [
      'an investigator’s thread merged into a plain item (the absorbed item only in its kept versions)',
      () => sticky([active(merged('A1', ['A2']))], { A2: byInvestigator('A2', { mergedInto: 'A1' }) }),
      'A1',
    ],
    [
      'an absorbed item that a chain of merges reaches',
      () => sticky([active(merged('A1', ['A2'])), addressed(merged('A2', ['A3'])), addressed(byInvestigator('A3'))]),
      'A1',
    ],
    [
      'a merged item the store cannot produce (provenance that cannot be told is withheld)',
      () => sticky([active(merged('A1', ['A8']))]),
      'A1',
    ],
    [
      'a plain item split from an investigator’s',
      () =>
        sticky([active({ ...plainItem('A1'), splitFrom: 'A2' }), active(byInvestigator('A2', { splitInto: ['A1'] }))]),
      'A1',
    ],
  ];

  test.each(CASES)(
    '%s: a foreign ferret reads none of it, exactly as an id that was never raised',
    async (_name, build, id) => {
      const read = build();
      const board = await read(`/v1/ferrets/${HIDDEN_BOARD}/agenda`);
      expect((JSON.parse(board.body) as { items: { id: string }[] }).items.map(item => item.id)).not.toContain(id);
      expect(board.body).not.toContain(W_REPLY);
      for (const suffix of ['', '/versions', '/versions/1', '/conversation']) {
        const hidden = await read(`/v1/ferrets/${HIDDEN_BOARD}/agenda/${id}${suffix}`);
        const absent = await read(`/v1/ferrets/${HIDDEN_BOARD}/agenda/A77${suffix}`);
        expect([suffix, shape(hidden, id)]).toEqual([suffix, shape(absent, 'A77')]);
      }
    },
  );

  test('the owner reads the merged item whole, and an ordinary merge of two plain items is plain to a ferret', async () => {
    const read = sticky([active(merged('A1', ['A2'])), addressed(plainItem('A2'))]);
    const ferret = await read(`/v1/ferrets/${HIDDEN_BOARD}/agenda/A1`);
    expect(ferret.status).toBe(200);
    expect(ferret.body).toContain(W_REPLY);
    const owner = await sticky([active(merged('A1', ['A2'])), addressed(byInvestigator('A2'))])(
      `/v1/ferrets/${HIDDEN_BOARD}/agenda/A1`,
      human,
    );
    expect(owner.body).toContain(W_REPLY);
  });
});
