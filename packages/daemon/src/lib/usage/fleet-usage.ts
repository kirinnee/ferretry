import type { FleetUsage, FleetUsageSnapshot } from '@ferretry/fleet';
import { type AccountAvailability, AccountUnavailableReasonSchema, type AccountUsage } from '@ferretry/protocol';
import type { CoreAccount } from '../core/inventory.ts';

/**
 * The daemon's own quota feed, expressed over the native fleet collector.
 *
 * The feed's two existing sources both reach outside Ferretry — an HTTP call to another tool's
 * collector, and a shell-out to that tool's CLI — so the quota every consumer reads was supplied by
 * the very tool this migration exists to delete. The collector that already answers
 * `GET /v1/fleet/usage` asks the provider directly, so the fix is a mapping rather than a second
 * refresh loop: the cached feed keeps its lazy refresh, its shared in-flight read, its retention of
 * the last good snapshot and its rendered metrics, and only the numbers underneath become native.
 *
 * TWO ROW SHAPES, TWO KEYS, AND ONLY ONE OF THEM ROUTES. A collector row is keyed by the manifest's
 * opaque `accountId`. A feed row is keyed by `agent` — the executable name a session is actually
 * launched with, which quota-failover hands to `migrate(...)` and the advisor matches on. They are
 * different values for the same account, so this mapping joins back to the manifest and carries
 * `CoreAccount.agent` across. Putting the account id in `agent` would type-check, satisfy every
 * schema and render a plausible `/usage` document that matches nothing at all, so failover would
 * quietly stop moving sessions off exhausted accounts while every internal measure looked healthy.
 */

/**
 * Whether a reading actually establishes this account's availability.
 *
 * A collector row always carries `unavailable`, but a row whose probe failed carries `false` because
 * nothing proved otherwise — not because the account was reached and found healthy. Only a proven
 * unavailability or a successful probe is evidence, and everything derived from availability rides
 * on this: an absent verdict leaves availability, `unavailable` and `atLimit` unstated rather than
 * stated benignly.
 */
function availabilityOf(row: FleetUsage): AccountAvailability | undefined {
  if (row.unavailable) return 'unavailable';
  return row.ok ? 'available' : undefined;
}

/**
 * One collector row as the feed's row, under the executable name the join supplied.
 *
 * An absent window becomes an absent field, never `0%`: the collector's whole fail-closed rule is
 * that unknown is not exhausted, and flattening a missing window to zero here would undo it at the
 * one place it is easiest to lose. `usageBased` is only carried from a successful probe for the same
 * reason — the collector writes `false` on a failed row, and repeating that would present an
 * unreadable account as one that simply has no subscription quota to report.
 */
function feedRow(row: FleetUsage, agent: string): AccountUsage {
  const availability = availabilityOf(row);
  const reason = AccountUnavailableReasonSchema.safeParse(row.unavailableReason);
  return {
    agent,
    ok: row.ok,
    ...(row.ok ? { usageBased: row.usageBased } : {}),
    ...(row.provider === undefined ? {} : { provider: row.provider }),
    ...(row.authOk === undefined ? {} : { authOk: row.authOk }),
    ...(availability === undefined ? {} : { availability, unavailable: availability === 'unavailable' }),
    // The collector's vocabulary for a reason is open and the wire's is a closed set, so a reason it
    // does not recognise is dropped while the unavailability itself survives. A row that says "this
    // account is down, for a reason I cannot name" is still the truth; inventing a member of the
    // enum to carry it would not be.
    ...(reason.success ? { unavailableReason: reason.data } : {}),
    ...(availability === undefined ? {} : { atLimit: row.atLimit }),
    ...(row.shortWindow?.usedPercent === undefined ? {} : { fiveHourPercent: row.shortWindow.usedPercent }),
    ...(row.longWindow?.usedPercent === undefined ? {} : { weeklyPercent: row.longWindow.usedPercent }),
    ...(row.shortWindow?.resetAt === undefined ? {} : { fiveHourResetAt: row.shortWindow.resetAt }),
    ...(row.longWindow?.resetAt === undefined ? {} : { weeklyResetAt: row.longWindow.resetAt }),
  };
}

/**
 * The collector's snapshot as the feed's account rows, or `undefined` when the join cannot be made.
 *
 * `undefined` is the source contract's "could not be read at all", and it is deliberately the answer
 * when the collector returned rows and not one of them could be named: a snapshot whose accounts are
 * all unjoinable is damaged evidence, not an empty fleet, and answering `[]` would let the feed
 * record "this host has no accounts" on the strength of a stale or foreign manifest. A collector that
 * genuinely reports no accounts still answers `[]`, which the feed leaves for the next source.
 *
 * An executable name two accounts claim is refused rather than resolved. The manifest treats that as
 * a defect, and attaching one account's quota to a name another account also answers to is precisely
 * how the source attributed one account's exhaustion to another's session.
 */
export function accountUsageFromFleet(
  snapshot: FleetUsageSnapshot,
  accounts: readonly CoreAccount[],
): readonly AccountUsage[] | undefined {
  const agentOf = new Map(accounts.map(account => [account.id, account.agent]));
  const claims = new Map<string, number>();
  for (const account of accounts) claims.set(account.agent, (claims.get(account.agent) ?? 0) + 1);

  const rows = snapshot.accounts
    .map(row => {
      const agent = agentOf.get(row.accountId);
      return agent === undefined || claims.get(agent) !== 1 ? undefined : feedRow(row, agent);
    })
    .filter((row): row is AccountUsage => row !== undefined);

  return rows.length === 0 && snapshot.accounts.length > 0 ? undefined : rows;
}
