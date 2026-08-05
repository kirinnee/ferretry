/**
 * Daemon-owned choices for account wrappers and recently used working
 * directories. Automatic hydration reads only the published manifest: quota
 * comes from the daemon's cached usage feed, while the expensive wrapper
 * health probe is an explicit action.
 *
 * Missing evidence stays missing. A fulfilled manifest with `accounts: []`
 * is positively empty; a rejected manifest read is represented by the store's
 * error slice and never converted into that empty array.
 */

import {
  type FleetManifestSummary,
  FleetManifestSummarySchema,
  type IFyApiClient,
  type SessionView,
} from '@ferretry/protocol';
import { z } from 'zod';

import { normalizeProjectPath } from './fleet-grouping.ts';

export type PickerAccount = FleetManifestSummary['accounts'][number];

export interface RecentProjectPath {
  readonly path: string;
  readonly lastActivity: string;
}

export interface AccountPickerCatalog {
  /** A fulfilled read; an empty array is positive evidence. */
  readonly accounts: readonly PickerAccount[];
}

export interface PickerAccountHealth {
  readonly accountId: string;
  /**
   * THE HARNESS THE DAEMON NAMED, AS IT NAMED IT. The health contract publishes a
   * non-empty string, not a closed set: a daemon that grows a third harness stays
   * conformant. Narrowing it here would only mean that an unfamiliar row failed
   * the schema and took every sibling row in the same snapshot with it — the
   * reader would lose health it already paid for, to learn nothing, since nothing
   * rendered reads this field.
   */
  readonly kind: string;
  readonly state: 'healthy' | 'down' | 'unknown';
  readonly cached: boolean;
  readonly checkedAt: number;
  readonly ms: number;
  readonly failureKind?:
    | 'rate_limited'
    | 'authentication'
    | 'timeout'
    | 'launch'
    | 'process_error'
    | 'unexpected_reply';
  readonly error?: string;
}

export interface AccountPickerHealthCatalog {
  readonly health: ReadonlyMap<string, PickerAccountHealth>;
  /** A partial result can still carry unambiguous rows. */
  readonly error: string | null;
}

export type PickerCatalogClient = Pick<IFyApiClient, 'request'>;

const finiteEpoch = z.number().finite().int().nonnegative();
const PickerAccountHealthSchema = z.strictObject({
  accountId: z.string().min(1),
  kind: z.string().min(1),
  state: z.enum(['healthy', 'down', 'unknown']),
  cached: z.boolean(),
  checkedAt: finiteEpoch,
  ms: finiteEpoch,
  failureKind: z
    .enum(['rate_limited', 'authentication', 'timeout', 'launch', 'process_error', 'unexpected_reply'])
    .optional(),
  error: z.string().min(1).optional(),
});
const PickerHealthSnapshotSchema = z.strictObject({
  at: finiteEpoch,
  accounts: z.array(PickerAccountHealthSchema),
});

interface UniqueIndex<T> {
  readonly values: ReadonlyMap<string, T>;
  readonly ambiguous: boolean;
}

/**
 * A duplicate health row is ambiguous evidence, not permission to pick the
 * last one returned. The duplicate account is removed so it renders unknown.
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

/** Read the cheap published roster through one already daemon-bound client. */
export const readAccountPickerCatalog = async (client: PickerCatalogClient): Promise<AccountPickerCatalog> => ({
  accounts: (await client.request('/v1/fleet/accounts', FleetManifestSummarySchema)).accounts,
});

/**
 * Run the expensive wrapper health probe only after an explicit reader action.
 * Unambiguous rows survive a duplicate elsewhere, but the damaged response is
 * still reported instead of being presented as wholly healthy.
 */
export const readAccountPickerHealth = async (client: PickerCatalogClient): Promise<AccountPickerHealthCatalog> => {
  const snapshot = await client.request('/v1/fleet/health', PickerHealthSnapshotSchema);
  const health = uniqueAccountIndex(snapshot.accounts);
  return {
    health: health.values,
    error: health.ambiguous ? 'the daemon returned ambiguous health rows' : null,
  };
};
