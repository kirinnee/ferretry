import { type AccountUsage, AccountUsageSchema } from '@ferretry/protocol';
import type { UsageSnapshot } from './types.ts';

/**
 * How long one collected snapshot is served when the fleet declares no interval of its own. The
 * daemon shares a single cached read across every session rather than multiplying provider probes
 * by the size of the fleet.
 *
 * It is a FALLBACK, not the cadence. The source hardcoded this constant and annotated it as being
 * the fleet tool's `usage.interval` — which is 60 seconds, not 300; 300 is that tool's *health*
 * interval. So the one place claiming the two numbers were the same number had already got which
 * number wrong, undetectably, because nothing read the declared one. It is kept conservative here
 * precisely because it now applies only where nothing has been declared.
 */
export const USAGE_REFRESH_MS = 300_000;

/**
 * The feed's refresh period, from the fleet's declared `usage.interval`.
 *
 * ONE NAME FOR ONE CADENCE. The fleet configuration and the daemon configuration each grew a way to
 * say how often quota is re-read — `usage.interval`, which was refused at plan time because nothing
 * re-probed on a schedule, and `usage.refreshSeconds`, which drove the only loop that existed. They
 * were always the same number. Now that the feed collects natively, the fleet's declaration is what
 * that loop runs on, and the second name is gone rather than left to disagree with the first.
 *
 * An absent interval is a host with no fleet configuration at all, which is a daemon that has not
 * been provisioned yet rather than one asking for a particular cadence, so it keeps the default.
 */
export function usageRefreshMs(intervalSeconds: number | undefined): number {
  return intervalSeconds === undefined ? USAGE_REFRESH_MS : intervalSeconds * 1_000;
}

/** Everything the feed remembers between reads. Replaced wholesale, never mutated in place. */
export interface UsageCacheState {
  readonly snapshot?: UsageSnapshot;
  /** Epoch ms before which a failed source is not probed again. */
  readonly retryAfter: number;
}

export const emptyUsageCache: UsageCacheState = { retryAfter: 0 };

export type UsageReadDecision =
  | { readonly kind: 'serve'; readonly accounts: readonly AccountUsage[] }
  | { readonly kind: 'refresh' };

/** The accounts a cache can serve right now — empty, never fabricated, before the first success. */
export function cachedAccounts(state: UsageCacheState): readonly AccountUsage[] {
  return state.snapshot?.accounts ?? [];
}

/**
 * Decide whether a read is answerable from cache.
 *
 * A snapshot stamped in the future is treated as expired rather than fresh: the source clock can
 * move backwards, and the original implementation's `now - at < refreshMs` comparison then pinned a
 * stale snapshot for the whole size of the jump.
 */
export function decideUsageRead(state: UsageCacheState, now: number, refreshMs: number): UsageReadDecision {
  const snapshot = state.snapshot;
  if (snapshot !== undefined && now >= snapshot.at && now - snapshot.at < refreshMs) {
    return { kind: 'serve', accounts: snapshot.accounts };
  }
  if (now < state.retryAfter) return { kind: 'serve', accounts: cachedAccounts(state) };
  return { kind: 'refresh' };
}

/**
 * Fold a completed refresh into the cache. A refresh that produced nothing at all keeps the last
 * good snapshot and backs off — a failed probe is not evidence that the fleet lost its accounts.
 */
export function recordUsageRefresh(
  state: UsageCacheState,
  accounts: readonly AccountUsage[] | undefined,
  now: number,
  refreshMs: number,
): UsageCacheState {
  if (accounts === undefined) return { ...state, retryAfter: now + refreshMs };
  return { snapshot: { at: now, accounts }, retryAfter: 0 };
}

const accountRows = (payload: unknown): readonly unknown[] | undefined => {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const accounts = (payload as { accounts?: unknown }).accounts;
  return Array.isArray(accounts) ? accounts : undefined;
};

/**
 * Parse one account row, discarding only the fields that are actually malformed.
 *
 * The source accepted any object carrying a string identifier and trusted every other field
 * unchecked, so a percentage of `900` or `"n/a"` reached session state intact. Validating the whole
 * row instead would swing too far the other way — one bad number would discard an account's
 * availability too — so a field that fails is dropped and the rest of the row survives.
 */
function parseAccountRow(row: unknown): AccountUsage | undefined {
  const first = AccountUsageSchema.safeParse(row);
  if (first.success) return first.data;
  if (typeof row !== 'object' || row === null) return undefined;
  const rejected = new Set(
    first.error.issues.map(issue => issue.path[0]).filter((key): key is string => typeof key === 'string'),
  );
  const retained = Object.fromEntries(Object.entries(row).filter(([key]) => !rejected.has(key)));
  const second = AccountUsageSchema.safeParse(retained);
  return second.success ? second.data : undefined;
}

/**
 * Read an account list out of a source payload, accepting either a bare array or the collector's
 * `{ at, accounts }` envelope. `undefined` means "not an account payload at all", which is what
 * makes a failed refresh distinguishable from a genuinely empty fleet.
 */
export function parseUsageAccounts(payload: unknown): readonly AccountUsage[] | undefined {
  const rows = accountRows(payload);
  if (rows === undefined) return undefined;
  return rows.map(parseAccountRow).filter((account): account is AccountUsage => account !== undefined);
}
