/**
 * Account quota for a session, resolved from the two places a daemon publishes
 * it. Ported from kteam `ui/src/lib/usage.ts`, with the single-daemon
 * assumption removed.
 *
 * The two sources are not redundant:
 *
 *   1. `state.usage*` — stamped onto a session by its own monitor loop. Live
 *      and authoritative, but only present while that session is monitored: a
 *      session in its first minute, an idle one, and every terminal one carry
 *      nothing.
 *   2. `GET /v1/usage` — the daemon's cached upstream feed, one row per agent
 *      wrapper. Available immediately, and identical for every session sharing
 *      a wrapper.
 *
 * (1) wins when present — it is the same feed already reconciled into that
 * session's state. (2) fills in the rest. When NEITHER has a record the answer
 * is `null`, and a caller must render "no data": zero percent is a claim the
 * daemon never made, and quota is exactly the readout a reader acts on.
 *
 * What changed for Ferretry: kteam kept ONE `Map<binary, UsageAccountView>`
 * for the whole app (`store.tsx:354`, `usage.ts:32-36`), because there was only
 * ever one daemon. Agent wrapper names are per-machine identifiers, not global
 * ones — two paired daemons both have a `claude` wrapper, at unrelated quota.
 * A shared index therefore serves one daemon's percentage under another's name,
 * so every feed value and every lookup here requires a `DaemonId` and there is
 * deliberately no agent-only public lookup to reach past it. The wire field is
 * also `agent` rather than kteam's `binary`.
 */

import { type SessionState, type SessionView, type UsageFeedView, UsageFeedViewSchema } from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';

/** One session's quota, normalized from whichever source supplied it. */
export interface ResolvedQuota {
  readonly fiveHourPercent?: number;
  readonly weeklyPercent?: number;
  readonly fiveHourResetAt?: number;
  readonly weeklyResetAt?: number;
  readonly atLimit?: boolean;
  readonly authOk?: boolean;
}

/**
 * The dashboard only needs to resolve one row's quota. Keeping this narrow
 * lets its connected page pass a `DaemonUsageStore` without exposing that
 * store's private feed index.
 */
export interface SessionQuotaResolver {
  quotaFor(daemonId: DaemonId, view: SessionView): ResolvedQuota | null;
}

/**
 * Fields whose presence proves the monitor loop has stamped this session.
 * Reset timestamps are deliberately excluded: a reset instant with no
 * percentage, limit or auth answer is not something a badge can render.
 */
const STATE_READOUT_FIELDS = ['usageAuthOk', 'usage5hPercent', 'usageWeeklyPercent', 'usageAtLimit'] as const;

const stateQuota = (state: SessionState): ResolvedQuota | null => {
  if (!STATE_READOUT_FIELDS.some(field => state[field] !== undefined)) return null;
  return {
    fiveHourPercent: state.usage5hPercent,
    weeklyPercent: state.usageWeeklyPercent,
    fiveHourResetAt: state.usage5hResetAt,
    weeklyResetAt: state.usageWeeklyResetAt,
    atLimit: state.usageAtLimit,
    authOk: state.usageAuthOk,
  };
};

/**
 * Does this quota carry anything worth rendering? A record an upstream knows
 * about but reports no usable numbers for is not a readout, and must not
 * occupy a badge that would then imply zero usage.
 */
export const hasReadout = (quota: ResolvedQuota | null): quota is ResolvedQuota => {
  if (quota === null) return false;
  return (
    quota.authOk === false ||
    quota.atLimit === true ||
    quota.fiveHourPercent !== undefined ||
    quota.weeklyPercent !== undefined
  );
};

/**
 * Per-daemon account-quota feeds and the session lookup over them.
 *
 * Every method takes the `DaemonId` that owns the data. Serving a cached feed
 * to the wrong daemon is a correctness bug, not a stale readout, so the type
 * offers no way to ask for an agent without naming its daemon.
 */
export class DaemonUsageIndex {
  readonly #feeds = new Map<DaemonId, UsageFeedView>();
  readonly #accounts = new Map<DaemonId, ReadonlyMap<string, ResolvedQuota>>();

  /**
   * Stores one daemon's feed, rejecting a malformed response whole. A partial
   * feed is not a shorter feed: it would read as "this wrapper has no quota"
   * for every row that failed to parse, so the previous valid feed is kept and
   * the caller is told the read failed.
   */
  apply(daemonId: DaemonId, value: unknown): boolean {
    const parsed = UsageFeedViewSchema.safeParse(value);
    if (!parsed.success) return false;
    const accounts = new Map<string, ResolvedQuota>();
    for (const account of parsed.data.accounts) {
      accounts.set(account.agent, {
        fiveHourPercent: account.fiveHourPercent,
        weeklyPercent: account.weeklyPercent,
        fiveHourResetAt: account.fiveHourResetAt,
        weeklyResetAt: account.weeklyResetAt,
        atLimit: account.atLimit,
        authOk: account.authOk,
      });
    }
    this.#feeds.set(daemonId, parsed.data);
    this.#accounts.set(daemonId, accounts);
    return true;
  }

  /** One daemon's last valid feed, for its own staleness and age readouts. */
  feed(daemonId: DaemonId): UsageFeedView | undefined {
    return this.#feeds.get(daemonId);
  }

  /**
   * The quota to display for a session on this daemon, or `null` when nothing
   * is known about its wrapper. Callers MUST treat `null` as "no data" rather
   * than as zero.
   */
  quotaFor(daemonId: DaemonId, view: SessionView): ResolvedQuota | null {
    return stateQuota(view.state) ?? this.#accounts.get(daemonId)?.get(view.config.agent) ?? null;
  }

  /** Drops one disconnected daemon's feed and leaves every other daemon's. */
  clearDaemon(daemonId: DaemonId): boolean {
    this.#accounts.delete(daemonId);
    return this.#feeds.delete(daemonId);
  }
}
