/**
 * Daemon-owned choices for account wrappers and recently used working
 * directories.
 *
 * AUTOMATIC HYDRATION NOW READS HEALTH TOO, and that is a change of cost rather
 * than a change of policy. Health used to mean "start every account's agent and
 * ask a model to answer a sentinel" — a real inference call per account, so
 * reading it on mount would have been a bottom sheet quietly spending money on
 * somebody else's machine, and it was a button with a warning beside it. It is
 * now a stored verdict the daemon derived from the free read-only usage GET it
 * already makes every minute, so `GET /v1/fleet/health` is a snapshot read:
 * instant, free, and safe to fetch beside the roster.
 *
 * The explicit action survives as `POST /v1/fleet/health/check`, which asks the
 * host to collect that free evidence NOW. It still spends nothing — one
 * read-only provider GET per credential, no model — and its copy says so.
 *
 * Missing evidence stays missing. A fulfilled manifest with `accounts: []`
 * is positively empty; a rejected manifest read is represented by the store's
 * error slice and never converted into that empty array. An account nobody has
 * ever checked carries `lastCheckedAt: null` rather than a fabricated instant,
 * which is why that field is nullable on the wire.
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

/** The four verdicts, spelled the same on both ends. */
export type PickerHealthVerdict = 'healthy' | 'needs_relogin' | 'needs_credentials' | 'unknown';

/**
 * WHY, as a code rather than a sentence.
 *
 * The daemon publishes the code and this app owns the words for it — see
 * `account-health-view.ts`. A daemon that shipped the sentence would be writing
 * browser copy, and the terminal would eventually disagree with the browser
 * about what a `403` means.
 */
export type PickerHealthReason =
  | 'provider_accepted'
  | 'usage_scope_unavailable'
  | 'oauth_credential_missing'
  | 'oauth_access_expired'
  | 'oauth_token_rejected'
  | 'static_credential_missing'
  | 'static_credential_rejected'
  | 'never_checked'
  | 'credential_unreadable'
  | 'oauth_refreshable'
  | 'oauth_rejection_unconfirmed'
  | 'codex_liveness_unproven'
  | 'check_timeout'
  | 'provider_unavailable'
  | 'provider_not_asked'
  | 'credential_changed_during_check'
  | 'account_unavailable'
  | 'stale';

export interface PickerAccountHealth {
  readonly accountId: string;
  /**
   * THE HARNESS THE DAEMON NAMED, AS IT NAMED IT. The health contract publishes a
   * non-empty string, not a closed set: a daemon that grows a third harness stays
   * conformant. Narrowing it here would only mean that an unfamiliar row failed
   * the schema and took every sibling row in the same snapshot with it — the
   * reader would lose health it already has, to learn nothing.
   */
  readonly kind: string;
  readonly verdict: PickerHealthVerdict;
  readonly reason: PickerHealthReason;
  readonly evidence: 'anthropic_usage' | 'local_credential' | 'none';
  /**
   * `null` means NOBODY HAS EVER CHECKED, and it is a different fact from every
   * number. The contract this replaced required a number, so a never-checked
   * account arrived with a fabricated "now" — indistinguishable on the wire from
   * a check that had just succeeded. Telling those two apart is the whole point.
   */
  readonly lastCheckedAt: number | null;
  /** When the evidence behind `verdict` was seen. Can be older than the check. */
  readonly verdictAt: number | null;
  /** The newest check could not conclude; `verdict` rests on older evidence. */
  readonly lastCheckInconclusive: boolean;
  /** What the verdict WAS before it aged out. Present only when `reason` is `stale`. */
  readonly staleVerdict?: PickerHealthVerdict;
  /**
   * Whether this account is still holding the copy a first run took from this host's own install.
   *
   * ABSENT MEANS NOTHING WAS RECORDED, and that is not a reading. A home seeded before the daemon
   * learned to record this has no record and can never get one, so a surface that rendered the
   * absence as "this account owns its credential" would be clearing exactly the hosts that cannot
   * be checked. Say nothing instead.
   */
  readonly seedProvenance?: PickerSeedProvenance;
}

/**
 * WHAT MAY BE CLAIMED ABOUT A HARNESS'S REFRESH TOKENS — a measurement, not a wording preference.
 *
 * `single_use` means the daemon holds evidence that redeeming the refresh token invalidates it, so
 * every other copy of that blob is left holding a dead one. `unproven` means nobody has measured it.
 * The daemon decides this once, for both the terminal and this browser, precisely so that the two
 * cannot drift into describing the same account differently — see `@ferretry/fleet`'s
 * `harnessRefreshRotation`. It is NOT re-derived here from `kind`.
 */
export type PickerRefreshRotation = 'single_use' | 'unproven';

export type PickerSeedProvenanceState = 'seeded_copy' | 'own_login' | 'undetermined';

export interface PickerSeedProvenance {
  readonly state: PickerSeedProvenanceState;
  /** The absolute directory the login was copied from, so somebody can go and check it. */
  readonly donorHome: string;
  readonly seededAt: number;
  readonly rotation: PickerRefreshRotation;
}

export interface AccountPickerHealthCatalog {
  readonly health: ReadonlyMap<string, PickerAccountHealth>;
  /** A partial result can still carry unambiguous rows. */
  readonly error: string | null;
}

export type PickerCatalogClient = Pick<IFyApiClient, 'request'>;

const finiteEpoch = z.number().finite().int().nonnegative();
const PickerHealthVerdictSchema = z.enum(['healthy', 'needs_relogin', 'needs_credentials', 'unknown']);
/** Registered in `scripts/validate/closed-set-agreement.ts` against the fleet package's own enum. */
const PickerSeedProvenanceStateSchema = z.enum(['seeded_copy', 'own_login', 'undetermined']);
const PickerRefreshRotationSchema = z.enum(['single_use', 'unproven']);
const PickerAccountHealthSchema = z.strictObject({
  accountId: z.string().min(1),
  kind: z.string().min(1),
  verdict: PickerHealthVerdictSchema,
  reason: z.enum([
    'provider_accepted',
    'usage_scope_unavailable',
    'oauth_credential_missing',
    'oauth_access_expired',
    'oauth_token_rejected',
    'static_credential_missing',
    'static_credential_rejected',
    'never_checked',
    'credential_unreadable',
    'oauth_refreshable',
    'oauth_rejection_unconfirmed',
    'codex_liveness_unproven',
    'check_timeout',
    'provider_unavailable',
    'provider_not_asked',
    'credential_changed_during_check',
    'account_unavailable',
    'stale',
  ]),
  evidence: z.enum(['anthropic_usage', 'local_credential', 'none']),
  lastCheckedAt: finiteEpoch.nullable(),
  verdictAt: finiteEpoch.nullable(),
  lastCheckInconclusive: z.boolean(),
  staleVerdict: PickerHealthVerdictSchema.optional(),
  seedProvenance: z
    .strictObject({
      state: PickerSeedProvenanceStateSchema,
      donorHome: z.string().min(1),
      seededAt: finiteEpoch,
      rotation: PickerRefreshRotationSchema,
    })
    .optional(),
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

/** Shared by both reads: a duplicate row is ambiguous, so the account renders unknown. */
const healthCatalog = (accounts: readonly PickerAccountHealth[]): AccountPickerHealthCatalog => {
  const health = uniqueAccountIndex(accounts);
  return {
    health: health.values,
    error: health.ambiguous ? 'the daemon returned ambiguous health rows' : null,
  };
};

/**
 * Read the stored verdicts. A pure snapshot: the daemon checks nothing to answer it.
 *
 * Safe to hydrate on mount, which is why the store now does. The evidence behind
 * these rows was collected by the host's own free usage pass, so reading them
 * costs one local HTTP call and no provider traffic at all.
 */
export const readAccountPickerHealth = async (client: PickerCatalogClient): Promise<AccountPickerHealthCatalog> => {
  const snapshot = await client.request('/v1/fleet/health', PickerHealthSnapshotSchema);
  return healthCatalog(snapshot.accounts);
};

/**
 * Ask the host to collect the free evidence NOW, and answer with the snapshot.
 *
 * The action behind "Check now". It is a POST because it records a reading, and it
 * spends nothing: one read-only `GET /api/oauth/usage` per credential on the
 * host, which is the same request that host's quota pass already makes every
 * minute. No agent is started and no model is asked anything.
 */
export const checkAccountPickerHealth = async (client: PickerCatalogClient): Promise<AccountPickerHealthCatalog> => {
  const snapshot = await client.request('/v1/fleet/health/check', PickerHealthSnapshotSchema, { method: 'POST' });
  return healthCatalog(snapshot.accounts);
};
