import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { fakeConversation } from '../../../../../plugins/conversation/contract/testing/index.ts';
import { fakeLogins, sampleLogin } from '../../../../../plugins/logins/contract/testing/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners, type FerretId } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import {
  deviceStanding,
  FakeGate,
  ferretStanding,
  ownerStanding,
  StandInAdmission,
} from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * Audit A fix 5 and 6: a FERRET's Warden answers must not CHANGE because of another lineage's data. Status codes, banners,
 * degraded states and timestamps all count. The REAL Ferrets and Warden halves run behind the stand-in admission (the
 * kernel cannot import Gate's daemon, `context-imports`): the caller's standing is the stand-in's `ferretStanding` /
 * `ownerStanding` / `deviceStanding`, the same `credential.tokenClass` the production Gate admits a ferret bearer, the admin
 * token and an enrolled device with. `core/gate/tests/unit/daemon/warden-routes-caller.test.ts` runs the real
 * `GateAdmission` over the shipped Warden routes and shows each admits a ferret bearer AS that ferret and refuses a ferret
 * the person-only ones. Each case plants a record of another lineage (an unreadable report, a stranger's failure, a half-recognisable
 * report) and proves the lead's answer is the same as before it, or a refusal; the owner and the device controls prove the
 * person's answers did not move. Fixture values only: no model, no spend, no real notice.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const COST = '0.45678';
const EXHAUSTED_SINCE = '2026-11-06T08:57:33.123Z';

const CALLER_HEADER = 'x-test-caller';
const PERSON_HEADER = 'x-test-person';

const world = async () => {
  const host = await testHost({
    plugins: [
      real('ferrets'),
      real('warden'),
      real('packs'),
      implementDaemon(
        definePlugin({
          id: 'claude-code',
          title: 'Claude Code (fake)',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
        }),
        { build: () => ({ hooks: { 'harnesses:claude-code': new FakeHarness() } }) },
      ),
      implementDaemon(
        definePlugin({
          id: 'terminals',
          title: 'Terminals (fake)',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
        }),
        { build: () => ({ hooks: { 'runners:tmux': new FakeRunner() } }) },
      ),
    ],
    gate: new StandInAdmission(request => {
      const caller = request.headers.get(CALLER_HEADER);
      if (caller !== null) return ferretStanding(caller as FerretId);
      return request.headers.get(PERSON_HEADER) === null ? ownerStanding() : deviceStanding('phone');
    }),
    fakes: {
      gate: new FakeGate(),
      vault: new FakeVault(),
      asks: new FakeAsks(),
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
    },
  });
  const begin = async (parent?: string): Promise<string> => {
    const started = await host.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { folder: '/work/project', ...(parent === undefined ? {} : { parent }) },
    });
    expect([started.status, JSON.stringify(started.json())]).toEqual([201, expect.anything()]);
    const { id } = started.json<{ id: string }>();
    const stopped = await host.request('POST', `/v1/ferrets/${id}/stop`);
    expect(stopped.status).toBe(200);
    return id;
  };
  // lead -> helper is one lineage; victim is a stranger with its own activity.
  const lead = await begin();
  const helper = await begin(lead);
  const victim = await begin();
  const asFerret = async (caller: string, route: string, query?: Record<string, string>) =>
    await host.request('GET', `/v1/warden/${route}`, {
      headers: { [CALLER_HEADER]: caller },
      ...(query === undefined ? {} : { query }),
    });
  const asOwner = async (route: string, query?: Record<string, string>) =>
    await host.request('GET', `/v1/warden/${route}`, { ...(query === undefined ? {} : { query }) });
  const asDevice = async (route: string, query?: Record<string, string>) =>
    await host.request('GET', `/v1/warden/${route}`, {
      headers: { [PERSON_HEADER]: 'phone' },
      ...(query === undefined ? {} : { query }),
    });
  const read = async (route: string, query?: Record<string, string>) => await asFerret(lead, route, query);
  return { host, lead, helper, victim, read, asFerret, asOwner, asDevice };
};

type World = Awaited<ReturnType<typeof world>>;

const put = (w: World, name: string, text: string) =>
  w.host.state('warden').bytes.set(`reports/${name}`, new TextEncoder().encode(text));
const leadReport = (w: World) => `# Warden report — ${w.lead}\n\nVERDICT: LEAVE\n`;
const stamp = (n: number) => `2026-11-06T0${n}-00-00-000Z`;
const shape = (response: { status: number; body: string }) => ({ status: response.status, body: response.body });

// ─── another lineage's report, readable or not, cannot change what the lead is told ────────────────────────────────

for (const route of ['verdicts', 'agenda', 'status'] as const) {
  for (const [what, name, text] of [
    ['an empty report named for the stranger', (w: World) => `${stamp(9)}-${w.victim}.md`, () => ''],
    ['an empty fleet report that names no one', () => `${stamp(9)}.md`, () => ''],
    [
      'a readable report about the stranger',
      (w: World) => `${stamp(9)}-${w.victim}.md`,
      (w: World) => `# Warden report — ${w.victim}\n\nVERDICT: NEEDS_HUMAN\n\ncost $${COST}\n`,
    ],
  ] as const) {
    test(`audit A fix 5 ${what} cannot change the lead's ${route} answer`, async () => {
      const w = await world();
      try {
        put(w, `${stamp(8)}-${w.lead}.md`, leadReport(w));
        const before = await w.read(route);
        expect(before.status).toBe(200);
        put(w, name(w), text(w));
        const after = await w.read(route);
        expect(shape(after)).toEqual(shape(before));
        expect(after.body).not.toContain(w.victim);
        expect(after.body).not.toContain(COST);
      } finally {
        await w.host.stop();
      }
    });
  }
}

test('audit A fix 5 a stranger’s failure instant is not on the lead’s agenda, and the plain state still is', async () => {
  const w = await world();
  try {
    w.host.setConfig('warden.yaml', { accounts: [{ agent: 'work' }] });
    const before = await w.read('agenda');
    expect(before.status).toBe(200);
    w.host.state('warden').files.set(
      'state.json',
      JSON.stringify({
        format: 1,
        failover: {
          exhaustedSince: EXHAUSTED_SINCE,
          strikes: { work: { count: 3, lastAt: w.host.clock.now(), lastReason: 'fixture victim failure' } },
        },
      }),
    );
    const after = await w.read('agenda');
    expect(after.status).toBe(200);
    expect(after.body).not.toContain(EXHAUSTED_SINCE);
    expect(after.json<{ outcome: string; wardenDegraded: Record<string, string> }>()).toMatchObject({
      outcome: 'degraded',
      wardenDegraded: { reason: expect.stringContaining('exhausted') },
    });
    expect(after.json<{ wardenDegraded: Record<string, string> }>().wardenDegraded.since).toBeUndefined();
  } finally {
    await w.host.stop();
  }
});

test('audit A fix 5 the lead’s OWN unreadable report is still its own to hear about', async () => {
  const w = await world();
  try {
    put(w, `${stamp(8)}-${w.lead}.md`, '');
    expect((await w.read('verdicts')).status).toBe(500);
    expect((await w.read('agenda')).json<{ wardenDegraded?: { reason: string } }>().wardenDegraded?.reason).toContain(
      'reports could not be read',
    );
  } finally {
    await w.host.stop();
  }
});

const MIXED = (w: World) =>
  `# Warden sweep (2026-11-06T09:00:00.000Z)\n\n## Anomaly: ${w.lead} — Caller\nVERDICT: LEAVE\n\n## Anomaly: \nVictim ${w.victim} diagnostic cost $${COST}\nVERDICT: NEEDS_HUMAN\n`;

// ─── audit A fix 6: a ferret is never served a report, and no model-written word reaches it ─────────────────────────

const REPORT_REFUSAL = 'The Warden’s reports are for the owner. Your own verdicts are at GET /v1/warden/verdicts.';

/** A fleet report whose OWN section is about the lead and whose prose names a stranger and a cost. */
const FLEET_WITH_PROSE = (w: World) =>
  `# Warden sweep (2026-11-06T09:00:00.000Z)\n\n## Anomaly: ${w.lead} — Caller\nVERDICT: NEEDS_HUMAN\n- **Recommended action:** MOVE (their-login) — ${w.victim} burned $${COST} on the migration\n- **Reported reason:** ${w.victim} cost $${COST}\n\n## Anomaly: ${w.victim} — Victim\nVERDICT: NEEDS_HUMAN\ncost $${COST}\n`;
/** An assigned report about the lead, in the same shape, with the same prose. */
const ASSIGNED_WITH_PROSE = (w: World) =>
  `Verdict: NEEDS_HUMAN\n\n# Warden report — ${w.lead} (teammate :caller, -)\n\n- **Anomaly kind:** unattended_question\n\n## Summary\n- **Recommended action:** NUDGE — ${w.victim} burned $${COST} on the migration\n`;

for (const [what, file, text] of [
  ['a fleet report', () => `${stamp(9)}.md`, FLEET_WITH_PROSE],
  ['an assigned report, the lead’s OWN', (w: World) => `${stamp(9)}-${w.lead}.md`, ASSIGNED_WITH_PROSE],
  ['an assigned report about the stranger', (w: World) => `${stamp(9)}-${w.victim}.md`, ASSIGNED_WITH_PROSE],
  ['a report that does not exist', () => `${stamp(9)}-nothing.md`, () => undefined],
] as const) {
  test(`audit A fix 6 ${what} is not found for a ferret, with one plain sentence`, async () => {
    const w = await world();
    try {
      const name = file(w);
      const body = text(w);
      if (body !== undefined) put(w, name, body);
      const found = await w.read('report', { path: name });
      expect(found.status).toBe(404);
      expect(found.body).toContain(REPORT_REFUSAL);
      expect(found.body).not.toContain(w.victim);
      expect(found.body).not.toContain(COST);
      // The helper (same lineage) is refused the same way, and so is a ferret that is nobody's lead.
      expect((await w.asFerret(w.helper, 'report', { path: name })).status).toBe(404);
      expect((await w.asFerret(w.victim, 'report', { path: name })).status).toBe(404);
      // The owner and a device read it whole, as before.
      if (body !== undefined) {
        for (const who of ['asOwner', 'asDevice'] as const) {
          const read = await w[who]('report', { path: name });
          expect(read.status).toBe(200);
          expect(read.body).toContain(COST);
        }
      }
    } finally {
      await w.host.stop();
    }
  });
}

test('audit A fix 6 the latest report is never on a ferret’s status, and the owner still has it', async () => {
  const w = await world();
  try {
    put(w, `${stamp(9)}-${w.lead}.md`, ASSIGNED_WITH_PROSE(w));
    const status = (await w.read('status')).json<Record<string, unknown>>();
    expect(status).not.toHaveProperty('lastReport');
    expect((await w.read('status')).body).not.toContain(COST);
    expect((await w.asOwner('status')).json<{ lastReport?: { reportId: string } }>().lastReport?.reportId).toBe(
      `${stamp(9)}-${w.lead}.md`,
    );
  } finally {
    await w.host.stop();
  }
});

test('audit A fix 6 a verdict row whose report names a victim and a cost reaches the ferret as a classification, a target and a time', async () => {
  const w = await world();
  try {
    put(w, `${stamp(9)}.md`, FLEET_WITH_PROSE(w));
    const rows = (await w.read('verdicts')).json<Record<string, unknown>[]>();
    // Only the lead's own section is a row; the stranger's section is another lineage's.
    expect(rows.map(row => row.target)).toEqual([w.lead]);
    const text = JSON.stringify(rows);
    for (const hidden of [w.victim, COST, 'their-login', 'migration', 'Caller', 'Victim'])
      expect(text).not.toContain(hidden);
    expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual(
      ['at', 'explicitNeedsHuman', 'reason', 'reportPath', 'target', 'verdict'].toSorted(),
    );
    expect(rows[0]).toMatchObject({
      target: w.lead,
      verdict: 'needs_human',
      reason: 'The Warden judged that this needs the owner.',
    });
    // The owner still reads the whole row.
    const owner = JSON.stringify((await w.asOwner('verdicts')).json());
    expect(owner).toContain(w.victim);
    expect(owner).toContain(COST);
  } finally {
    await w.host.stop();
  }
});

test('audit A fix 6 a stranger’s section beside the lead’s own does not change the lead’s row', async () => {
  const w = await world();
  try {
    const own = `# Warden sweep (2026-11-06T09:00:00.000Z)\n\n## Anomaly: ${w.lead} — Caller\nVERDICT: LEAVE\n`;
    put(w, `${stamp(9)}.md`, own);
    const before = await w.read('verdicts');
    put(
      w,
      `${stamp(9)}.md`,
      `${own}\n## Anomaly: ${w.victim} — Victim\nVERDICT: NEEDS_HUMAN\ncost $${COST}\n\n## Anomaly: \nunreadable heading $${COST}\n`,
    );
    const after = await w.read('verdicts');
    expect(shape(after)).toEqual(shape(before));
  } finally {
    await w.host.stop();
  }
});

// ─── audit A fix 6: a ferret's "last swept" is its own lineage's, never the fleet's ───────────────────────────────────

const T1 = '2026-11-06T09:00:00.000Z';
const T2 = '2026-11-06T09:04:00.000Z';
const T3 = '2026-11-06T09:08:00.000Z';
const setSweeps = (w: World, state: Record<string, unknown>) =>
  w.host.state('warden').files.set('state.json', JSON.stringify({ format: 1, ...state }));

test('audit A fix 6 lastSweepAt is absent for a ferret whose lineage the latest sweep did not scan, and so is the agenda’s verdict', async () => {
  const w = await world();
  try {
    setSweeps(w, { lastSweepAt: T1, scanned: { [w.victim]: T1 } });
    const status = await w.read('status');
    expect(status.json<Record<string, unknown>>()).not.toHaveProperty('lastSweepAt');
    const agenda = await w.read('agenda');
    expect(agenda.json<{ outcome: string }>().outcome).toBe('no-sweep');
    expect(agenda.json<Record<string, unknown>>()).not.toHaveProperty('lastSweepAt');
    // Only the stranger's sweep moves: the lead's answers do not.
    setSweeps(w, { lastSweepAt: T3, scanned: { [w.victim]: T3 } });
    expect(shape(await w.read('status'))).toEqual(shape(status));
    expect((await w.read('agenda')).body).not.toContain(T3);
    expect((await w.read('agenda')).json<{ outcome: string }>().outcome).toBe('no-sweep');
    // A stale global sweep cannot make the lead's agenda "overdue" either.
    setSweeps(w, { lastSweepAt: '2020-01-01T00:00:00.000Z', scanned: { [w.victim]: '2020-01-01T00:00:00.000Z' } });
    expect((await w.read('agenda')).json<{ outcome: string }>().outcome).toBe('no-sweep');
  } finally {
    await w.host.stop();
  }
});

test('audit A fix 6 lastSweepAt is the newest sweep that scanned the lineage, the helper’s included', async () => {
  const w = await world();
  try {
    setSweeps(w, { lastSweepAt: T3, scanned: { [w.lead]: T1, [w.helper]: T2, [w.victim]: T3 } });
    expect((await w.read('status')).json<{ lastSweepAt: string }>().lastSweepAt).toBe(T2);
    const agenda = (await w.read('agenda')).json<{ outcome: string; lastSweepAt: string }>();
    expect(agenda.lastSweepAt).toBe(T2);
    expect((await w.read('status')).body).not.toContain(T3);
  } finally {
    await w.host.stop();
  }
});

for (const who of ['asOwner', 'asDevice'] as const) {
  test(`audit A fix 6 control: ${who} still reads the global lastSweepAt`, async () => {
    const w = await world();
    try {
      setSweeps(w, { lastSweepAt: T3, scanned: { [w.victim]: T3 } });
      expect((await w[who]('status')).json<{ lastSweepAt: string }>().lastSweepAt).toBe(T3);
      expect((await w[who]('agenda')).json<{ lastSweepAt: string }>().lastSweepAt).toBe(T3);
    } finally {
      await w.host.stop();
    }
  });
}

// ─── controls: the owner and a device keep today's answers ──────────────────────────────────────────────────────────

for (const who of ['asOwner', 'asDevice'] as const) {
  test(`audit A fix 5 control: ${who} still reads the whole fleet, an unreadable report and the failure instant as before`, async () => {
    const w = await world();
    try {
      w.host.setConfig('warden.yaml', { accounts: [{ agent: 'work' }] });
      put(w, `${stamp(8)}-${w.victim}.md`, MIXED(w));
      const mixed = await w[who]('report', { path: `${stamp(8)}-${w.victim}.md` });
      expect(mixed.status).toBe(200);
      expect(mixed.body).toContain(w.victim);
      expect(mixed.body).toContain(COST);
      expect((await w[who]('verdicts')).status).toBe(200);
      // An unreadable report still fails the whole fleet's verdicts and darkens the agenda, for the owner.
      put(w, `${stamp(9)}-${w.victim}.md`, '');
      expect((await w[who]('verdicts')).status).toBe(500);
      expect((await w[who]('agenda')).json<{ wardenDegraded?: { reason: string } }>().wardenDegraded?.reason).toContain(
        'reports could not be read',
      );
      w.host.state('warden').bytes.delete(`reports/${stamp(9)}-${w.victim}.md`);
      w.host
        .state('warden')
        .files.set(
          'state.json',
          JSON.stringify({ format: 1, failover: { exhaustedSince: EXHAUSTED_SINCE, strikes: {} } }),
        );
      expect((await w[who]('agenda')).json<{ wardenDegraded?: { since?: string } }>().wardenDegraded?.since).toBe(
        EXHAUSTED_SINCE,
      );
    } finally {
      await w.host.stop();
    }
  });
}

// ─── audit A fix 7: the scope narrows a fleet report BEFORE the limit ────────────────────────────────────────────────

test('audit A fix 7 many foreign sections ahead of the lead’s own do not evict its row from the verdicts, and the owner’s list is cut as before', async () => {
  const w = await world();
  try {
    const foreign = Array.from({ length: 30 }, (_, index) => `## Anomaly: stranger-${index}\nVERDICT: LEAVE\n`).join(
      '\n',
    );
    put(
      w,
      `${stamp(9)}.md`,
      `# Warden sweep (2026-11-06T09:00:00.000Z)\n\n${foreign}\n## Anomaly: ${w.lead} — Caller\nVERDICT: NEEDS_HUMAN\n`,
    );
    const rows = (await w.read('verdicts')).json<Record<string, unknown>[]>();
    expect(rows.map(row => row.target)).toEqual([w.lead]);
    expect(rows[0]).toMatchObject({ verdict: 'needs_human' });
    // The owner reads the first twenty of the whole report, as before: the lead's row is past the cut.
    const owner = (await w.asOwner('verdicts')).json<Record<string, unknown>[]>();
    expect(owner).toHaveLength(20);
    expect(owner.map(row => row.target)).not.toContain(w.lead);
  } finally {
    await w.host.stop();
  }
});
