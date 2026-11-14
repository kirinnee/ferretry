import type { UsageApi, UsageAccountView } from '@ferretry/plugin-usage/contract';
import type { WardenAccountHealth } from './lib/failover.ts';

/** Which of Usage's reads the warden takes: the account-health feed, and nothing it could write or spend. */
export type WardenUsageSource = Pick<UsageApi, 'feed'>;

/** One feed row as the failover selector reads it: only the facts it judges eligibility from. */
function healthOf(account: UsageAccountView): WardenAccountHealth {
  return {
    agent: account.agent,
    ...(account.authOk === undefined ? {} : { authOk: account.authOk }),
    ...(account.atLimit === undefined ? {} : { atLimit: account.atLimit }),
    ...(account.unavailable === undefined ? {} : { unavailable: account.unavailable }),
    ...(account.unavailableReason === undefined ? {} : { unavailableReason: account.unavailableReason }),
    ...(account.retryAt === undefined ? {} : { retryAt: account.retryAt }),
  };
}

/**
 * The account health the failover selector and the status read, from Usage's feed (§2.3: Usage is an optional use).
 *
 * Total: with Usage off, or a read that fails, no account has any evidence against it and none for it, which the
 * selector reads as "unknown" — a feed outage must not stop supervision at the moment it is needed most
 * (`usableAccount`). The warden is never a viewer of the feed, so it never causes a provider read of its own.
 */
export function usageHealth(source: () => WardenUsageSource | undefined): {
  accounts(): Promise<readonly WardenAccountHealth[]>;
} {
  return {
    accounts: async () => {
      const usage = source();
      if (usage === undefined) return [];
      try {
        return (await usage.feed({ watched: false })).accounts.map(healthOf);
      } catch {
        return [];
      }
    },
  };
}
