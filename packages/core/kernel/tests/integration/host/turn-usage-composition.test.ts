import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { fakeConversation } from '../../../../../plugins/conversation/contract/testing/index.ts';
import { fakeLogins, sampleLogin } from '../../../../../plugins/logins/contract/testing/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners, type TurnUsage, type UsageReader } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner, T0 } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * M4 through the daemon: the REAL Ferrets and the REAL Usage halves, as the generated registry builds them. Usage asks
 * Ferrets (`turnUsage`) what a ferret spent, and Ferrets reads it from the harness the ferret runs. A harness that reports
 * turns makes the ferret's tokens evidence; one that cannot be read makes them "unknown", never zero. (The Claude harness's
 * own transcript reader is proved by its package's tests.) Fixture values only.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

/** A harness whose usage reader answers `turns`, or throws when it is `undefined`. */
class SpendingHarness extends FakeHarness {
  constructor(private readonly spent: readonly TurnUsage[] | undefined) {
    super();
  }
  override readonly usage: UsageReader = {
    turns: async (): Promise<readonly TurnUsage[]> => {
      if (this.spent === undefined) throw new Error('transcript unreadable');
      return this.spent;
    },
  };
}

const world = async (harness: FakeHarness) => {
  const runner = new FakeRunner();
  const host = await testHost({
    plugins: [
      real('ferrets'),
      real('usage'),
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
        { build: () => ({ hooks: { 'runners:tmux': runner } }) },
      ),
    ],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gate: new FakeGate(),
      vault: new FakeVault(),
      asks: new FakeAsks(),
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
    },
  });
  const started = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/project' },
  });
  expect(started.status).toBe(201);
  const { id } = started.json<{ id: string }>();
  expect((await host.request('POST', `/v1/ferrets/${id}/stop`)).status).toBe(200);
  await host.runJob('usage-ingest');
  const insights = await host.request('GET', '/v1/usage/insights', {
    query: { q: 'sum by (token_data)', session: id },
  });
  return { host, insights: JSON.stringify(insights.json()) };
};

test('M4 a stopped ferret whose harness reports a turn has its tokens counted by Usage, through Ferrets', async () => {
  const turn: TurnUsage = { turn: 1, at: T0, model: 'claude-sonnet-4-5', inputTokens: 1200, outputTokens: 300 };
  const { host, insights } = await world(new SpendingHarness([turn]));
  expect(insights).toContain('"known"');
  expect(insights).not.toContain('"unknown"');
  await host.stop();
});

test('M4 a ferret whose harness reader throws is unknown to Usage, never zero', async () => {
  const { host, insights } = await world(new SpendingHarness(undefined));
  expect(insights).toContain('"unknown"');
  await host.stop();
});
