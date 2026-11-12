import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { fakeConversation } from '../../../../../plugins/conversation/contract/testing/index.ts';
import { fakeLogins, sampleLogin } from '../../../../../plugins/logins/contract/testing/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import {
  Harnesses,
  Runners,
  type FerretId,
  type TurnUsage,
  type UsageReader,
} from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner, T0 } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * M4 / audit A fix 1: `GET /v1/usage/insights` through the daemon, the REAL Ferrets and the REAL Usage halves as the
 * generated registry builds them. The index holds every stopped ferret's exact token figures. The owner (and a person)
 * keeps the whole fleet; a FERRET caller sees only its own lineage (itself and its descendants, Ferrets' `mayTouch`):
 * naming a ferret outside it is refused (403), and an unscoped query is narrowed to the lineage, so no aggregate or raw
 * row carries another ferret's tokens. The caller's standing is the Gate stand-in's `ferretStanding`, the same
 * `credential.tokenClass: 'ferret'` the production Gate admits a ferret bearer with
 * (`core/gate/tests/unit/daemon/usage-insights-caller.test.ts` runs the real `GateAdmission` over the shipped
 * `GET /v1/usage/insights` descriptor). Fixture values only.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

/** A harness whose usage reader answers the turns each ferret was given, by id. */
class SpendingHarness extends FakeHarness {
  readonly spent = new Map<string, readonly TurnUsage[]>();
  override readonly usage: UsageReader = {
    turns: async (ferret): Promise<readonly TurnUsage[]> => this.spent.get(String(ferret)) ?? [],
  };
}

const turn = (inputTokens: number, outputTokens: number): TurnUsage => ({
  turn: 1,
  at: T0,
  model: 'claude-sonnet-4-5',
  inputTokens,
  outputTokens,
});

const CALLER_HEADER = 'x-test-caller';

const world = async () => {
  const harness = new SpendingHarness();
  const host = await testHost({
    plugins: [
      real('ferrets'),
      real('usage'),
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
        { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
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
    const { id } = started.json<{ id: string }>();
    expect((await host.request('POST', `/v1/ferrets/${id}/stop`)).status).toBe(200);
    return id;
  };
  // lead -> helper -> grandHelper is one lineage; victim is a stranger with its own tokens.
  const lead = await begin();
  const helper = await begin(lead);
  const grandHelper = await begin(helper);
  const victim = await begin();
  harness.spent.set(lead, [turn(100, 10)]);
  harness.spent.set(helper, [turn(200, 20)]);
  harness.spent.set(grandHelper, [turn(300, 30)]);
  harness.spent.set(victim, [turn(1200, 300)]);
  await host.runJob('usage-ingest');
  const insights = async (caller: string | undefined, query: Record<string, string>) =>
    await host.request('GET', '/v1/usage/insights', {
      ...(caller === undefined ? {} : { headers: { [CALLER_HEADER]: caller } }),
      query,
    });
  return { host, lead, helper, grandHelper, victim, insights };
};

type Raw = { results: { id: string; inputTokens: number | null }[] };
type Aggregate = { results: { sessions: number; inputTokens: { value: number | null } }[] };

test('M4 owner keeps the whole fleet: a chosen session and the unscoped raw list', async () => {
  const { host, victim, lead, insights } = await world();
  try {
    const one = await insights(undefined, { q: '{}', session: victim });
    expect(one.status).toBe(200);
    expect(one.json<Raw>().results[0]).toMatchObject({ id: victim, inputTokens: 1200, outputTokens: 300 });
    const all = await insights(undefined, { q: '{}' });
    expect(all.status).toBe(200);
    expect(all.json<Raw>().results.map(row => row.id)).toContain(victim);
    expect(all.json<Raw>().results.map(row => row.id)).toContain(lead);
  } finally {
    await host.stop();
  }
});

test('M4 an unrelated ferret asking for a chosen victim session is refused and sees no victim figure', async () => {
  const { host, victim, lead, insights } = await world();
  try {
    const other = await insights(lead, { q: '{}', session: victim });
    expect(other.status).toBe(403);
    expect(JSON.stringify(other.json())).not.toContain('1200');
    // a ferret the registry has never heard of is a stranger to everything but itself
    const unknown = await insights('unrelated', { q: '{}', session: victim });
    expect(unknown.status).toBe(403);
  } finally {
    await host.stop();
  }
});

test('M4 an unscoped raw query by a ferret is narrowed to its own lineage (no victim row, no victim figure)', async () => {
  const { host, victim, lead, helper, grandHelper, insights } = await world();
  try {
    const mine = await insights(lead, { q: '{}' });
    expect(mine.status).toBe(200);
    const ids = mine
      .json<Raw>()
      .results.map(row => row.id)
      .sort();
    expect(ids).toEqual([lead, helper, grandHelper].sort());
    expect(mine.json<{ scope: { indexed: number; matched: number }; index: { sessions: number } }>()).toMatchObject({
      scope: { indexed: 3, matched: 3 },
      index: { sessions: 3 },
    });
    expect(JSON.stringify(mine.json())).not.toContain(victim);

    const stranger = await insights('unrelated', { q: '{}' });
    expect(stranger.status).toBe(200);
    expect(stranger.json<Raw>().results).toEqual([]);
    expect(stranger.json<{ scope: { indexed: number } }>().scope.indexed).toBe(0);
    expect(JSON.stringify(stranger.json())).not.toContain('1200');
  } finally {
    await host.stop();
  }
});

test('M4 an aggregate by a ferret sums only its own lineage; a helper never sees its lead', async () => {
  const { host, lead, helper, insights } = await world();
  try {
    const owner = await insights(undefined, { q: 'sum(tokens_input)' });
    const sums = (response: { json<T>(): T }) => {
      const row = response.json<Aggregate>().results[0];
      return row === undefined ? undefined : { sessions: row.sessions, input: row.inputTokens.value };
    };
    expect(sums(owner)).toEqual({ sessions: 4, input: 1800 }); // 100 + 200 + 300 + 1200
    const asLead = await insights(lead, { q: 'sum(tokens_input)' });
    expect(sums(asLead)).toEqual({ sessions: 3, input: 600 }); // 100 + 200 + 300
    const asHelper = await insights(helper, { q: '{}' });
    expect(asHelper.json<Raw>().results.map(row => row.id)).not.toContain(lead);
    expect((await insights(helper, { q: '{}', session: lead })).status).toBe(403);
    expect((await insights(helper, { q: '{}', session: helper })).status).toBe(200);
  } finally {
    await host.stop();
  }
});
