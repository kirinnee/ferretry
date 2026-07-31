import type { AccountUsage, SessionState } from '@ferretry/protocol';

/** The normalized quota block carried on session state and served to clients. */
export type SessionQuota = NonNullable<SessionState['quota']>;

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
