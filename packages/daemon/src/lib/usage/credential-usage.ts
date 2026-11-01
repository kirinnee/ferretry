import { type FleetManifest, manifestRuntimes, wrapperNameOf } from '@ferretry/fleet';
import type {
  AccountUsage,
  FleetCredentialList,
  FleetCredentialUsageWindow,
  FleetCredentialView,
} from '@ferretry/protocol';
import { limitedCredentials, type PaneLimit } from './pane-limit.ts';
import { providerAccountFields } from './provider-quota/account.ts';
import type { UsageSourcePort } from './types.ts';

/**
 * The daemon's own quota feed, read from what the account model's credentials already know.
 *
 * Every number here was gathered by the EXISTING usage pass — the passive readings first, then the one
 * free usage read when those are older than the pass interval — and is read back from the credentials
 * surface's own list, which makes no network call. So the feed adds no probe of its own: a session's
 * quota, the advisor, Warden autoMigrate and every scraper read the same reading the Credentials tab shows.
 *
 * ONE CREDENTIAL, MANY ROWS. A feed row is keyed by `agent` — the executable name a session is launched
 * with, which Warden autoMigrate hands to `migrate(...)` and the advisor matches on. A credential is shared
 * by every runtime on it, so each published runtime row in the manifest becomes one feed row carrying
 * its credential's reading. The join goes through the MANIFEST because that is what a launch reads:
 * a runtime the configuration names but no apply published has no executable to attribute quota to.
 */
export interface CredentialUsageSourceDeps {
  /** Whether unattended usage collection is switched on (`usage.enabled`), read per refresh. */
  enabled(): Promise<boolean>;
  /** The credentials surface's list: status words and usage windows, from what is already known. */
  credentials(): Promise<FleetCredentialList>;
  /** The published manifest, or `undefined` when no apply has published one yet. */
  manifest(): Promise<FleetManifest | undefined>;
  /**
   * The limits live sessions' panes prove, by agent (executable name). Absent: none are read. A failure
   * is no limits, not a failed feed: the pane evidence only ever adds a limit the provider did not say.
   */
  limits?(): Promise<ReadonlyMap<string, PaneLimit>>;
}

/**
 * A failure is `undefined`, never `[]`. An unreadable configuration, an unreadable manifest and a
 * credential list that refused all mean this source could not answer — not that the fleet has no
 * accounts — so the feed keeps its last good snapshot and tries the next source instead.
 */
export class CredentialUsageSource implements UsageSourcePort {
  constructor(private readonly deps: CredentialUsageSourceDeps) {}

  async read(signal?: AbortSignal): Promise<readonly AccountUsage[] | undefined> {
    if (signal?.aborted === true) return undefined;
    try {
      // `usage.enabled: false` turns off UNATTENDED collection, which is what this feed is.
      if (!(await this.deps.enabled())) return undefined;
      const manifest = await this.deps.manifest();
      if (manifest === undefined) return undefined;
      const list = await this.deps.credentials();
      const limits = await this.deps.limits?.().catch(() => undefined);
      return credentialUsageRows(manifest, list.credentials, limits);
    } catch {
      return undefined;
    }
  }
}

/** Each published runtime as a feed row, under its executable name, carrying its credential's reading. */
export function credentialUsageRows(
  manifest: FleetManifest,
  credentials: readonly FleetCredentialView[],
  paneLimits: ReadonlyMap<string, PaneLimit> = new Map(),
): readonly AccountUsage[] {
  const byId = new Map(credentials.map(credential => [credential.id, credential] as const));
  const runtimes = manifestRuntimes(manifest).map(runtime => ({
    agent: wrapperNameOf(runtime.wrapper),
    credential: runtime.credential,
  }));
  const limited = limitedCredentials(paneLimits, runtimes);
  return runtimes.flatMap(runtime => {
    const credential = byId.get(runtime.credential);
    return credential === undefined ? [] : [usageRow(runtime.agent, credential, limited.get(runtime.credential))];
  });
}

/** A window's percentage as the feed carries it: bounded to 100, and absent when nobody measured it. */
const percent = (window: FleetCredentialUsageWindow): number | undefined =>
  window.usedPercent === undefined ? undefined : Math.min(100, window.usedPercent);

const resetAt = (window: FleetCredentialUsageWindow): number | undefined =>
  window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt);

/**
 * One credential's reading as one runtime's row.
 *
 * `checking` states nothing about availability: a check in flight has not concluded, and saying
 * "available" for it would be the benign reading of absent evidence. The daemon's feed lists its
 * credentials SETTLED, so it does not meet one: a cached `checking` row outlived its check and said
 * "not known" for a whole interval. A list that does say it is still answered honestly.
 *
 * `needs_sign_in` is a proven unavailability for `auth`. An absent window is an absent field, never `0%`.
 *
 * An environment login's provider quota (`usage.provider`) adds what only it can say — money left,
 * this month's transcript cost, and an at-limit the provider itself reported.
 */
function usageRow(agent: string, credential: FleetCredentialView, limit?: PaneLimit): AccountUsage {
  const word = credential.status.word;
  const known = word !== 'checking';
  const signedIn = word === 'ready' || word === 'refresh_due';
  const fiveHour = percent(credential.usage.fiveHour);
  const weekly = percent(credential.usage.weekly);
  const fiveHourReset = resetAt(credential.usage.fiveHour);
  const weeklyReset = resetAt(credential.usage.weekly);
  return {
    agent,
    ok: known,
    ...(known
      ? {
          authOk: signedIn,
          availability: signedIn ? 'available' : 'unavailable',
          unavailable: !signedIn,
          ...(signedIn ? {} : { unavailableReason: 'auth' as const }),
          atLimit:
            fiveHour === 100 ||
            weekly === 100 ||
            (credential.usage.provider?.via === 'endpoint' && credential.usage.provider.exhausted) ||
            limit !== undefined,
        }
      : {}),
    // A pane that says the login is spent outranks a feed that has not noticed. Only a signed-in login
    // is relabelled: a rejected credential stays an `auth` problem for a person to fix.
    ...(known && signedIn && limit?.spend === true
      ? { availability: 'unavailable' as const, unavailable: true, unavailableReason: 'spend_limit' as const }
      : {}),
    ...(known && signedIn && limit?.retryAt !== undefined ? { retryAt: limit.retryAt } : {}),
    ...(fiveHour === undefined ? {} : { fiveHourPercent: fiveHour }),
    ...(weekly === undefined ? {} : { weeklyPercent: weekly }),
    ...(fiveHourReset === undefined ? {} : { fiveHourResetAt: fiveHourReset }),
    ...(weeklyReset === undefined ? {} : { weeklyResetAt: weeklyReset }),
    ...(credential.usage.provider === undefined ? {} : providerExtras(credential.usage.provider)),
  };
}

/** The provider reading's money fields; its windows already rode in on `fiveHour` and `weekly`. */
function providerExtras(reading: NonNullable<FleetCredentialView['usage']['provider']>): Partial<AccountUsage> {
  const { balance, spendUsd } = providerAccountFields(reading);
  return { ...(balance === undefined ? {} : { balance }), ...(spendUsd === undefined ? {} : { spendUsd }) };
}
