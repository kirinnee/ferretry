import { describe, it } from 'bun:test';
import type { AccountUsage, ProviderQuotaReading } from '@ferretry/protocol';
import should from 'should';
import {
  overlayProviderQuota,
  type ProviderQuotaWatcher,
  unattendedUsageFeed,
  WatchedUsageFeed,
} from '../../../../src/lib/usage/provider-quota/watched-feed.ts';
import type { UsageFeedPort } from '../../../../src/lib/usage/types.ts';

const BALANCE: ProviderQuotaReading = {
  source: 'deepseek-balance',
  via: 'endpoint',
  windows: [],
  balance: { amount: 0, currency: 'USD' },
  exhausted: true,
  unverified: false,
  at: '2026-10-16T09:00:00.000Z',
};

const ROWS: readonly AccountUsage[] = [
  { agent: 'ds-agent', ok: true, authOk: true, atLimit: false },
  { agent: 'claude', ok: true, fiveHourPercent: 10 },
];

class FakeFeed implements UsageFeedPort {
  reads = 0;
  async accounts(): Promise<readonly AccountUsage[]> {
    this.reads += 1;
    return ROWS;
  }
  snapshotAt(): number | undefined {
    return 42;
  }
  hasSnapshot(): boolean {
    return true;
  }
}

class FakeWatcher implements ProviderQuotaWatcher {
  watches = 0;
  async watch(): Promise<void> {
    this.watches += 1;
  }
  peekAgent(agent: string): ProviderQuotaReading | undefined {
    return agent === 'ds-agent' ? BALANCE : undefined;
  }
}

describe('WatchedUsageFeed', () => {
  it('should let the quota reader read first, then lay its readings over the rows', async () => {
    // Arrange
    const watcher = new FakeWatcher();
    const feed = new WatchedUsageFeed(new FakeFeed(), () => watcher);

    // Act
    const rows = await feed.accounts();

    // Assert
    should(watcher.watches).equal(1);
    should(rows).deepEqual([
      { agent: 'ds-agent', ok: true, authOk: true, atLimit: true, balance: { amount: 0, currency: 'USD' } },
      ROWS[1],
    ]);
    should(feed.snapshotAt()).equal(42);
    should(feed.hasSnapshot()).be.true();
  });

  it('should never ask a provider for an unattended reader or a cancelled one, and still lay the cache over', async () => {
    // Arrange
    const watcher = new FakeWatcher();
    const inner = new FakeFeed();
    const feed = new WatchedUsageFeed(inner, () => watcher);
    const cancelled = new AbortController();
    cancelled.abort();

    // Act
    const unattended = await unattendedUsageFeed(feed).accounts();
    await feed.accounts(cancelled.signal);

    // Assert
    should(watcher.watches).equal(0);
    should(unattended[0]).containDeep({ atLimit: true });
    should(unattendedUsageFeed(feed).snapshotAt()).equal(42);
    should(unattendedUsageFeed(feed).hasSnapshot()).be.true();
    should(inner.reads).equal(2);
  });

  it('should pass rows through untouched before the quota reader exists, and leave a plain feed as it is', async () => {
    // Arrange
    const inner = new FakeFeed();
    const feed = new WatchedUsageFeed(inner, () => undefined);

    // Act & Assert
    should(await feed.accounts()).equal(ROWS);
    should(unattendedUsageFeed(inner)).equal(inner);
    should(overlayProviderQuota(ROWS, { peekAgent: () => undefined })).deepEqual(ROWS);
  });
});
