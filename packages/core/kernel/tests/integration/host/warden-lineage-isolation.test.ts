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
 * Audit A fix 5: a FERRET's Warden answers must not CHANGE because of another lineage's data. Status codes, banners,
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
  return { host, lead, helper, victim, read, asOwner, asDevice };
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

// ─── a report is the lead's only when EVERY part of it is attributable to the lead ──────────────────────────────────

const MIXED = (w: World) =>
  `# Warden sweep (2026-11-06T09:00:00.000Z)\n\n## Anomaly: ${w.lead} — Caller\nVERDICT: LEAVE\n\n## Anomaly: \nVictim ${w.victim} diagnostic cost $${COST}\nVERDICT: NEEDS_HUMAN\n`;

for (const [what, text] of [
  ['an own section beside a section whose target is missing', MIXED],
  [
    'an own section beside a heading the parser cannot read',
    (w: World) => `## Anomaly: ${w.lead} — Caller\nVERDICT: LEAVE\n\n## Anomaly —\nVictim ${w.victim} $${COST}\n`,
  ],
  [
    'an own section beside a stranger’s section',
    (w: World) =>
      `## Anomaly: ${w.lead} — Caller\nVERDICT: LEAVE\n\n## Anomaly: ${w.victim} — Victim\nVERDICT: NEEDS_HUMAN\ncost $${COST}\n`,
  ],
  [
    'an own section with a stranger named in its prose',
    (w: World) => `## Anomaly: ${w.lead} — Caller\nVERDICT: LEAVE\n\nSee also ${w.victim}, cost $${COST}.\n`,
  ],
  [
    'an own section beside an unrelated second-level section',
    (w: World) => `## Anomaly: ${w.lead} — Caller\nVERDICT: LEAVE\n\n## Fleet summary\ncost $${COST}\n`,
  ],
  ['an assigned report with no header', () => `VERDICT: LEAVE\n\ncost $${COST}\n`],
  [
    'an assigned report with a second header',
    (w: World) => `# Warden report — ${w.lead}\nVERDICT: LEAVE\n\n# Warden report — ${w.victim}\ncost $${COST}\n`,
  ],
] as const) {
  test(`audit A fix 5 ${what} is not found, in the report, the latest report or the verdicts`, async () => {
    const w = await world();
    try {
      const own = `${stamp(7)}-${w.lead}.md`;
      put(w, own, leadReport(w));
      const baseline = {
        verdicts: shape(await w.read('verdicts')),
        status: (await w.read('status')).json<{ lastReport?: unknown }>().lastReport,
      };
      for (const file of [`${stamp(9)}-${w.lead}.md`, `${stamp(9)}.md`]) {
        put(w, file, text(w));
        const found = await w.read('report', { path: file });
        expect([file, found.status]).toEqual([file, 404]);
        expect(found.body).not.toContain(w.victim);
        expect(found.body).not.toContain(COST);
        // Neither the newest report nor a verdict row is built from the half-recognised one.
        expect((await w.read('status')).json<{ lastReport?: unknown }>().lastReport).toEqual(baseline.status);
        expect(shape(await w.read('verdicts'))).toEqual(baseline.verdicts);
        w.host.state('warden').bytes.delete(`reports/${file}`);
      }
      // The owner and a device still read it whole.
      put(w, `${stamp(9)}.md`, text(w));
      expect((await w.asOwner('report', { path: `${stamp(9)}.md` })).status).toBe(200);
      expect((await w.asDevice('report', { path: `${stamp(9)}.md` })).status).toBe(200);
    } finally {
      await w.host.stop();
    }
  });
}

test('audit A fix 5 a report that is wholly the lead’s is still read, in the report, the latest report and the verdicts', async () => {
  const w = await world();
  try {
    const file = `${stamp(9)}.md`;
    put(
      w,
      file,
      `# Warden sweep (2026-11-06T09:00:00.000Z)\n\n## Anomaly: ${w.lead} — Caller\nVERDICT: LEAVE\n\n## Anomaly: ${w.helper} — Helper\nVERDICT: NUDGE\n`,
    );
    expect((await w.read('report', { path: file })).status).toBe(200);
    expect((await w.read('status')).json<{ lastReport: { reportId: string } }>().lastReport.reportId).toBe(file);
    expect(
      (await w.read('verdicts'))
        .json<{ target: string }[]>()
        .map(row => row.target)
        .toSorted(),
    ).toEqual([w.helper, w.lead].toSorted());
  } finally {
    await w.host.stop();
  }
});

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
