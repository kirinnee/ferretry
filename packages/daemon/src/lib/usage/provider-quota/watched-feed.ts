import type { AccountUsage } from '@ferretry/protocol';
import type { UsageFeedPort } from '../types.ts';
import { providerAccountFields } from './account.ts';
import type { ProviderQuotaService } from './service.ts';

/** The two calls the feed makes of the quota reader. */
export type ProviderQuotaWatcher = Pick<ProviderQuotaService, 'watch' | 'peekAgent'>;

/**
 * Each row whose runtime is on an environment login, with that login's latest provider reading laid
 * over it. A cache read: it never asks a provider anything.
 */
export function overlayProviderQuota(
  rows: readonly AccountUsage[],
  quota: Pick<ProviderQuotaService, 'peekAgent'>,
): readonly AccountUsage[] {
  return rows.map(row => {
    const reading = quota.peekAgent(row.agent);
    return reading === undefined ? row : { ...row, ...providerAccountFields(reading) };
  });
}

/**
 * The usage feed as a WATCHER reads it (docs/provider-quotas.md): a screen polling `/v1/usage`, the
 * Warden's sweep and auto-migrate. Each read first lets the quota reader read the environment logins
 * that are due — at most once a minute each — and then answers the shared feed with the fresh readings
 * laid over it, so a provider's quota shows on the next poll instead of the next feed refresh.
 *
 * {@link WatchedUsageFeed.unattended} is the same feed for a reader nobody is behind — the daemon's
 * refresh timer, a metrics scrape: it lays the cached readings over and asks no provider anything.
 *
 * The quota reader is late-bound because the feed is built before the logins it reads exist.
 */
export class WatchedUsageFeed implements UsageFeedPort {
  readonly unattended: UsageFeedPort;

  constructor(
    private readonly inner: UsageFeedPort,
    private readonly quota: () => ProviderQuotaWatcher | undefined,
  ) {
    this.unattended = {
      accounts: async signal => this.#overlay(await inner.accounts(signal)),
      snapshotAt: () => inner.snapshotAt(),
      hasSnapshot: () => inner.hasSnapshot(),
    };
  }

  async accounts(signal?: AbortSignal): Promise<readonly AccountUsage[]> {
    if (signal?.aborted !== true) await this.quota()?.watch();
    return this.#overlay(await this.inner.accounts(signal));
  }

  snapshotAt(): number | undefined {
    return this.inner.snapshotAt();
  }

  hasSnapshot(): boolean {
    return this.inner.hasSnapshot();
  }

  #overlay(rows: readonly AccountUsage[]): readonly AccountUsage[] {
    const quota = this.quota();
    return quota === undefined ? rows : overlayProviderQuota(rows, quota);
  }
}

/** The feed as a reader nobody is behind should see it: a watched feed's unattended half, or itself. */
export function unattendedUsageFeed(feed: UsageFeedPort): UsageFeedPort {
  return feed instanceof WatchedUsageFeed ? feed.unattended : feed;
}
