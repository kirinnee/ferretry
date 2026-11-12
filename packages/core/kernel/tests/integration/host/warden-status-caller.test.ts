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
