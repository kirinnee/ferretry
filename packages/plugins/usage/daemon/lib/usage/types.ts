import type { AccountUsage } from '../../../contract/index.ts';

/** The normalized quota block a ferret's state carries and the clients are served. */
export interface SessionQuota {
  readonly usageBased?: boolean;
  readonly availability?: 'available' | 'unavailable';
  readonly unavailable?: boolean;
  readonly unavailableReason?: 'cooldown' | 'spend_limit' | 'auth' | 'provider' | 'no_credentials';
  readonly retryAt?: number;
  readonly atLimit?: boolean;
  readonly authOk?: boolean;
  readonly provider?: string;
  readonly fiveHourPercent?: number;
  readonly weeklyPercent?: number;
  readonly fiveHourResetAt?: number;
  readonly weeklyResetAt?: number;
  readonly resetAt?: number;
  readonly limitNotice?: string;
}

/**
 * How an account authenticates. Declared by fleet configuration — never inferred from a provider
 * name, so adding a provider cannot silently produce impossible remediation advice.
 */
export type AccountAuthMode = 'oauth' | 'api-key';

/** A point-in-time reading of the whole account inventory. */
export interface UsageSnapshot {
  readonly at: number;
  readonly accounts: readonly AccountUsage[];
}

/**
 * The upstream account-health source. Implemented by an adapter; the feed's caching decisions stay
 * pure and are exercised without any transport.
 */
export interface UsageSourcePort {
  /** Resolves to the accounts, or `undefined` when the source could not be read at all. */
  read(signal?: AbortSignal): Promise<readonly AccountUsage[] | undefined>;
}

/** The daemon-wide cached view every consumer shares instead of probing per session. */
export interface UsageFeedPort {
  accounts(signal?: AbortSignal): Promise<readonly AccountUsage[]>;
  snapshotAt(): number | undefined;
  hasSnapshot(): boolean;
}
