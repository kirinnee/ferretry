import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { fakeConversation } from '../../../../../plugins/conversation/contract/testing/index.ts';
import { fakeLogins, sampleLogin } from '../../../../../plugins/logins/contract/testing/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners, type FerretId } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner, T0 } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * Audit A fix 2: `GET /v1/warden/status` through the daemon, the REAL Ferrets and the REAL Warden halves. The status lists
 * the checks Jev made and what each cost, by target. The owner reads them all; a FERRET reads only the checks about itself
 * and its helpers (Ferrets' `mayTouch`), so an unrelated ferret's diagnostic spend is not a figure it can read. The
 * caller's standing is the stand-in's `ferretStanding`. A stored check is planted; nothing is spent. Fixture values only.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const CALLER_HEADER = 'x-test-caller';

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
      return caller === null ? ownerStanding() : ferretStanding(caller as FerretId);
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
    return started.json<{ id: string }>().id;
  };
  const lead = await begin();
  const helper = await begin(lead);
  const victim = await begin();
  const check = (sessionId: string, costUsd: number) => ({
    at: T0,
    sessionId,
    anomalyKind: 'sus_thinking',
    verdict: 'healthy',
    confidence: 0.9,
    costUsd,
  });
  host
    .state('warden')
    .files.set(
      'jev-checks/2026-11-06.json',
      JSON.stringify({ format: 1, checks: [check(victim, 0.12345), check(helper, 0.0042), check(lead, 0.0011)] }),
    );
  const investigation = (id: string, targetId: string, costUsd: number) => ({
    id,
    scope: 'session',
    origin: 'owner',
    targetId,
    startedAt: T0,
    finishedAt: T0,
    reportPath: `reports/${id}.md`,
    costUsd,
  });
  host.state('warden').files.set(
    'state.json',
    JSON.stringify({
      format: 1,
      investigations: [investigation('inv-victim', victim, 0.77), investigation('inv-lead', lead, 0.05)],
    }),
  );
  const status = async (caller?: string) =>
    await host.request('GET', '/v1/warden/status', {
      ...(caller === undefined ? {} : { headers: { [CALLER_HEADER]: caller } }),
    });
  return { host, lead, helper, victim, status };
};

type Checks = { jevChecks?: { ferret: string; costUsd: number }[]; investigations: { id: string; costUsd?: number }[] };

test('audit A fix 2 the owner reads every Jev check; a ferret reads only the checks about its own lineage', async () => {
  const { host, lead, helper, victim, status } = await world();
  try {
    const owner = await status();
    expect(owner.status).toBe(200);
    expect(
      owner
        .json<Checks>()
        .jevChecks?.map(check => check.ferret)
        .toSorted(),
    ).toEqual([helper, lead, victim].toSorted());

    const own = await status(lead);
    expect(own.status).toBe(200);
    expect(
      own
        .json<Checks>()
        .jevChecks?.map(check => check.ferret)
        .toSorted(),
    ).toEqual([helper, lead].toSorted());
    expect(own.body).not.toContain(victim);
    expect(own.body).not.toContain('0.12345');
    // The same rule for what a warden's investigation cost about a target.
    expect(own.json<Checks>().investigations.map(entry => entry.id)).toEqual(['inv-lead']);
    expect(own.body).not.toContain('0.77');
    expect(
      owner
        .json<Checks>()
        .investigations.map(entry => entry.id)
        .toSorted(),
    ).toEqual(['inv-lead', 'inv-victim']);

    // A helper does not see its lead's checks, and the stranger sees only its own.
    expect((await status(helper)).json<Checks>().jevChecks?.map(check => check.ferret)).toEqual([helper]);
    expect((await status(victim)).json<Checks>().jevChecks?.map(check => check.ferret)).toEqual([victim]);
  } finally {
    await host.stop();
  }
});

/**
 * Audit A fix 3: a FERRET caller's status is lineage-only. Spend, savings, history and the action/revive totals are fleet
 * aggregates of diagnostic activity ABOUT other targets, so a ferret gets none of them (the owner keeps all); it sees
 * only whether Warden is capped, never an amount. A pack investigation has no target, so it belongs to no lineage.
 * Checks are filtered to the lineage BEFORE the newest-N cut, so unrelated checks cannot hide a lead's own.
 */
const AGGREGATES = ['spend', 'savings', 'history', 'actionTotals', 'reviveTotals'] as const;

const plantActivity = (host: Awaited<ReturnType<typeof world>>['host'], victim: string) => {
  const day = host.clock.now().slice(0, 10);
  const zeros = { auto: 0, jev: 0, llm: 0 };
  host.state('warden').files.set(
    'state.json',
    JSON.stringify({
      format: 1,
      triageDay: { day, flags: 1, jevDecisions: 1, jevSkips: 1, jevUsd: 0.12345 },
      costAverage: { count: 1, totalUsd: 0.77 },
      investigations: [
        {
          id: 'inv-victim',
          scope: 'session',
          origin: 'owner',
          targetId: victim,
          startedAt: host.clock.now(),
          finishedAt: host.clock.now(),
          reportPath: 'reports/victim.md',
          costUsd: 0.77,
        },
        {
          id: 'inv-fleet',
          scope: 'fleet',
          origin: 'owner',
          startedAt: host.clock.now(),
          finishedAt: host.clock.now(),
          reportPath: 'reports/fleet.md',
          costUsd: 0.45678,
        },
      ],
      daily: [
        {
          day,
          flags: 1,
          jevDecisions: 1,
          investigations: 1,
          jevUsd: 0.12345,
          investigationUsd: 0.77,
          moved: zeros,
          cleared: zeros,
          stopped: zeros,
          asked: zeros,
          acts: [{ action: 'revive', outcome: 'done', auto: 7, jev: 0, llm: 0 }],
          reviveResults: { progressed: { auto: 7, jev: 0, llm: 0 }, stalled: zeros },
        },
      ],
    }),
  );
};

test('audit A fix 3 a ferret reads no fleet aggregate and no pack investigation; the owner keeps every one', async () => {
  const { host, lead, victim, status } = await world();
  try {
    plantActivity(host, victim);
    const own = await status(lead);
    expect(own.status).toBe(200);
    const body = own.json<Record<string, unknown> & Checks>();
    for (const field of AGGREGATES) expect(body[field]).toBeUndefined();
    // The targetless pack investigation belongs to no lineage; the victim's is outside this one.
    expect(body.investigations).toEqual([]);
    for (const figure of ['0.12345', '0.77', '0.45678', 'inv-fleet', 'reports/fleet.md'])
      expect(own.body).not.toContain(figure);

    const owner = (await status()).json<Record<string, unknown> & Checks>();
    for (const field of AGGREGATES) expect(owner[field]).toBeDefined();
    expect(owner.investigations.map(entry => entry.id).toSorted()).toEqual(['inv-fleet', 'inv-victim']);
    expect((owner.spend as { jevUsd: number }).jevUsd).toBe(0.12345);
  } finally {
    await host.stop();
  }
});

test('audit A fix 3 a ferret sees that Warden is capped, never an amount, limit or remaining budget', async () => {
  const { host, lead, victim, status } = await world();
  try {
    plantActivity(host, victim);
    // Today's Jev spend is past a tiny cap, which the owner sees as an amount and a ferret as a state only.
    host.state('warden').files.set(
      'state.json',
      JSON.stringify({
        format: 1,
        triageDay: { day: host.clock.now().slice(0, 10), flags: 1, jevDecisions: 1, jevSkips: 1, jevUsd: 987.654 },
      }),
    );
    const own = (await status(lead)).json<{ triage: { jev: { reason: string } } }>();
    expect(JSON.stringify(own)).not.toContain('987.654');
    expect(JSON.stringify(own)).not.toMatch(/CapUsd|remaining|pacedUntil|pendingInvestigations/u);
    expect(own.triage.jev.reason).toBeDefined();
  } finally {
    await host.stop();
  }
});

test("audit A fix 3 unrelated Jev checks cannot evict a lead's own check before the lineage filter", async () => {
  const { host, lead, victim, status } = await world();
  try {
    const at = host.clock.now();
    const check = (sessionId: string, costUsd: number) => ({
      at,
      sessionId,
      anomalyKind: 'sus_thinking',
      verdict: 'healthy',
      confidence: 0.9,
      costUsd,
    });
    const file = `jev-checks/${at.slice(0, 10)}.json`;
    host.state('warden').files.set(file, JSON.stringify({ format: 1, checks: [check(lead, 0.0011)] }));
    const before = (await status(lead)).json<Checks>().jevChecks;
    expect(before).toHaveLength(1);
    host.state('warden').files.set(
      file,
      JSON.stringify({
        format: 1,
        checks: [check(lead, 0.0011), ...Array.from({ length: 50 }, () => check(victim, 0.12345))],
      }),
    );
    const after = await status(lead);
    expect(after.json<Checks>().jevChecks).toEqual(before);
    // The owner's view is still the newest fifty, whoever they were about.
    expect((await status()).json<Checks>().jevChecks).toHaveLength(50);
  } finally {
    await host.stop();
  }
});
