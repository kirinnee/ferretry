import { describe, it } from 'bun:test';
import { FleetConfigSchema, type FleetUsageSnapshot } from '@ferretry/fleet';
import should from 'should';
import { CachedUsageFeed, type FleetUsageReader, FleetUsageSource } from '../../../src/adapters/usage/index.ts';
import type { AccountInventoryPort, CoreAccount, UsageSourcePort } from '../../../src/lib/index.ts';

const ACCOUNT_ID = '4c0f3b6e-7a91-4a2f-9a7f-2b1d0f5c8e31';

const manifest = (...accounts: readonly CoreAccount[]): AccountInventoryPort => ({ accounts: async () => accounts });

const account: CoreAccount = {
  id: ACCOUNT_ID,
  agent: 'claude-writer',
  wrapper: '/state/fleet/bin/claude-writer',
  home: '/state/fleet/homes/writer',
  kind: 'claude',
  mode: 'auto',
  displayName: 'Writer',
  defaultModel: 'sonnet',
  models: [{ id: 'sonnet', available: true }],
  available: true,
  unavailableReason: null,
};

const collector = (answer: FleetUsageSnapshot | Error, enabled = true): FleetUsageReader => ({
  config: async () => FleetConfigSchema.parse({ usage: { enabled } }),
  usage: async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  },
});

const snapshot: FleetUsageSnapshot = {
  at: 1_700_000_000_000,
  accounts: [
    {
      accountId: ACCOUNT_ID,
      kind: 'claude',
      provider: 'anthropic',
      usageBased: true,
      ok: true,
      unavailable: false,
      authOk: true,
      atLimit: false,
      shortWindow: { usedPercent: 42 },
    },
  ],
};

describe('FleetUsageSource', () => {
  it("should read the feed rows from this host's own collector", async () => {
    // Arrange
    const source = new FleetUsageSource(collector(snapshot), manifest(account));

    // Act
    const accounts = await source.read();

    // Assert — keyed by the executable name a session launches with, not by the account id.
    should(accounts).deepEqual([
      {
        agent: 'claude-writer',
        ok: true,
        usageBased: true,
        provider: 'anthropic',
        authOk: true,
        availability: 'available',
        unavailable: false,
        atLimit: false,
        fiveHourPercent: 42,
      },
    ]);
  });

  it('should report nothing when the fleet has not been applied', async () => {
    // Arrange — an unapplied fleet raises; that is "could not read", never "no accounts".
    const source = new FleetUsageSource(collector(new Error('no published fleet manifest')), manifest(account));

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).be.undefined();
  });

  it('should abandon an already-cancelled read before it starts a provider call', async () => {
    // Arrange
    const source = new FleetUsageSource(collector(new Error('the collector must not be reached')), manifest(account));

    // Act
    const accounts = await source.read(AbortSignal.abort());

    // Assert
    should(accounts).be.undefined();
  });

  it('should collect nothing when the fleet has usage switched off', async () => {
    // Arrange — usage.enabled reached nothing before: it parsed, defaulted to true and was dropped,
    // so an operator who turned quota probing off still had a daemon probing on a timer.
    const source = new FleetUsageSource(collector(snapshot, false), manifest(account));

    // Act
    const accounts = await source.read();

    // Assert — "do not collect" is not "this fleet has no accounts".
    should(accounts).be.undefined();
  });

  it('should be preferred over an external source that also answers', async () => {
    // Arrange — the wiring the composition root builds: native first, another tool behind it.
    const external: UsageSourcePort = { read: async () => [{ agent: 'claude-writer', fiveHourPercent: 99 }] };
    const feed = new CachedUsageFeed([new FleetUsageSource(collector(snapshot), manifest(account)), external]);

    // Act
    const accounts = await feed.accounts();

    // Assert
    should(accounts.map(entry => entry.fiveHourPercent)).deepEqual([42]);
  });

  it('should leave a host with no fleet to the source behind it', async () => {
    // Arrange — part-way through a migration the external tool may still be the only thing answering.
    const external: UsageSourcePort = { read: async () => [{ agent: 'claude-writer', fiveHourPercent: 99 }] };
    const native = new FleetUsageSource(collector(new Error('no fleet config')), manifest(account));

    // Act
    const accounts = await new CachedUsageFeed([native, external]).accounts();

    // Assert
    should(accounts.map(entry => entry.fiveHourPercent)).deepEqual([99]);
  });
});
