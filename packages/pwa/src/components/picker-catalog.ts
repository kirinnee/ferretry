/**
 * Daemon-owned choices for the two places where a person would otherwise have
 * to type an opaque identifier: account wrappers and working directories.
 *
 * Missing evidence stays missing. In particular, `accounts: []` means the
 * daemon positively returned an empty manifest, while `accounts: null` means
 * the manifest could not be read. Quota and health are independent live reads:
 * either may fail without erasing the roster, but no row then claims a healthy
 * or unexhausted state it cannot prove.
 */

import {
  type FleetHealth,
  FleetHealthSnapshotSchema,
  type FleetUsage,
  FleetUsageSnapshotSchema,
} from '@ferretry/fleet';
import {
  type FleetManifestSummary,
  FleetManifestSummarySchema,
  type IFyApiClient,
  type SessionView,
} from '@ferretry/protocol';

import { normalizeProjectPath } from '../lib/fleet-grouping.ts';

export type PickerAccount = FleetManifestSummary['accounts'][number];

export interface RecentProjectPath {
  readonly path: string;
  readonly lastActivity: string;
}

export interface AccountPickerCatalog {
  /** null = unreadable, [] = positively empty. */
  readonly accounts: readonly PickerAccount[] | null;
  readonly accountsError: string | null;
  readonly usage: ReadonlyMap<string, FleetUsage>;
  readonly usageError: string | null;
  readonly health: ReadonlyMap<string, FleetHealth>;
  readonly healthError: string | null;
}

export type PickerCatalogClient = Pick<IFyApiClient, 'request'>;

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

const resultValue = <T>(result: PromiseSettledResult<T>): T | null =>
  result.status === 'fulfilled' ? result.value : null;

const resultError = <T>(result: PromiseSettledResult<T>): string | null =>
  result.status === 'rejected' ? failureMessage(result.reason) : null;

interface UniqueIndex<T> {
  readonly values: ReadonlyMap<string, T>;
  readonly ambiguous: boolean;
}

/**
 * A duplicate live row is ambiguous evidence, not permission to pick the last
 * one returned by the daemon. The duplicate id is removed from the map so its
 * account renders as unknown, and the catalog reports the damaged feed.
 */
const uniqueAccountIndex = <T extends { readonly accountId: string }>(rows: readonly T[]): UniqueIndex<T> => {
  const values = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    if (values.has(row.accountId) || duplicates.has(row.accountId)) {
      values.delete(row.accountId);
      duplicates.add(row.accountId);
    } else {
      values.set(row.accountId, row);
    }
  }
  return { values, ambiguous: duplicates.size > 0 };
};

const activityInstant = (view: SessionView): string => view.state.lastActivityAt ?? view.config.updatedAt;

/** Recently used daemon-canonical cwds, newest first and deduplicated by path. */
export const recentProjectPaths = (sessions: readonly SessionView[]): readonly RecentProjectPath[] => {
  const newest = new Map<string, string>();
  for (const session of sessions) {
    const path = normalizeProjectPath(session.config.cwd.trim());
    if (path === '') continue;
    const activity = activityInstant(session);
    const previous = newest.get(path);
    if (previous === undefined || Date.parse(activity) > Date.parse(previous)) newest.set(path, activity);
  }
  return [...newest.entries()]
    .map(([path, lastActivity]) => ({ path, lastActivity }))
    .sort((left, right) => {
      const recency = Date.parse(right.lastActivity) - Date.parse(left.lastActivity);
      return recency === 0 ? left.path.localeCompare(right.path) : recency;
    });
};

/** An explicit failed read; never substitute an empty roster for it. */
export const unavailableAccountPickerCatalog = (reason: string): AccountPickerCatalog => ({
  accounts: null,
  accountsError: reason,
  usage: new Map(),
  usageError: reason,
  health: new Map(),
  healthError: reason,
});

/**
 * Read the roster and both live feeds through one already daemon-bound client.
 * Reads settle independently: a health probe failure cannot turn a positively
 * read roster into an empty fleet.
 */
export const readAccountPickerCatalog = async (client: PickerCatalogClient): Promise<AccountPickerCatalog> => {
  const [accountsRead, usageRead, healthRead] = await Promise.allSettled([
    client.request('/v1/fleet/accounts', FleetManifestSummarySchema),
    client.request('/v1/fleet/usage', FleetUsageSnapshotSchema),
    client.request('/v1/fleet/health', FleetHealthSnapshotSchema),
  ] as const);

  const manifest = resultValue(accountsRead);
  const usageSnapshot = resultValue(usageRead);
  const healthSnapshot = resultValue(healthRead);
  const usage = uniqueAccountIndex(usageSnapshot?.accounts ?? []);
  const health = uniqueAccountIndex(healthSnapshot?.accounts ?? []);

  return {
    accounts: manifest?.accounts ?? null,
    accountsError: resultError(accountsRead),
    usage: usage.values,
    usageError: usage.ambiguous ? 'the daemon returned ambiguous quota rows' : resultError(usageRead),
    health: health.values,
    healthError: health.ambiguous ? 'the daemon returned ambiguous health rows' : resultError(healthRead),
  };
};
