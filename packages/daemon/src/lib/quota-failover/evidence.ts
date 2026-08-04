/**
 * What counts as "out of tokens", and what counts as "has room" — the two questions automatic
 * failover is only allowed to act on when it can answer them from a MEASUREMENT.
 *
 * BOTH DIRECTIONS FAIL CLOSED, and they fail closed towards opposite answers, which is the whole
 * shape of this module:
 *
 *   * An account the feed cannot speak for is NOT exhausted. Migrating a session because a probe
 *     failed would destroy a pane over a transport error, and "the collector is down" is the exact
 *     moment every account looks equally silent. Absent evidence is not evidence of exhaustion.
 *   * An account the feed cannot speak for is NOT a target either. Moving a session into an account
 *     nobody has scored is how a session lands on a second exhausted account — worse than stopping,
 *     because it spends the preflight's one admission and looks like the feature failing.
 *
 * SO EXHAUSTION IS NARROWER THAN "UNHEALTHY", deliberately. Rejected credentials are not a quota
 * condition: a human has to log in, and moving the session elsewhere hides the account that needs
 * attention while the fleet quietly shrinks by one. The same goes for a provider that declares itself
 * down for `auth`, `provider` or `no_credentials` reasons. Only a measured limit — the tokens are
 * spent — and the two provider reasons that mean the same thing (`cooldown`, `spend_limit`) qualify.
 *
 * Pure: no IO, no clock, no globals.
 */

import type { AccountUsage } from '@ferretry/protocol';
import { confirmedUsableAccount, spentPercent, unusableAccountReason } from '../usage/account-health.ts';
import { quotaFromUsage } from '../usage/quota.ts';

/** The two provider verdicts that mean the same thing as a spent limit. */
const EXHAUSTION_REASONS = new Set(['cooldown', 'spend_limit']);

/** How spent an account measured, as a phrase, or nothing when neither window was read. */
function measurement(usage: AccountUsage): string {
  const quota = quotaFromUsage(usage);
  const parts = [
    quota.fiveHourPercent === undefined ? undefined : `5h ${quota.fiveHourPercent}%`,
    quota.weeklyPercent === undefined ? undefined : `weekly ${quota.weeklyPercent}%`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

/**
 * Why this account is out of tokens, or `undefined` while nothing measured says it is.
 *
 * A string rather than a boolean because the reason is carried onto the journal entry and the
 * report: a human reading that a session moved has to be able to see the reading it moved on.
 */
export function quotaExhaustionReason(usage: AccountUsage | undefined): string | undefined {
  // No row at all. The account may be perfectly fine and simply unlisted; either way nothing here
  // measured anything, so nothing here may destroy a pane.
  if (usage === undefined) return undefined;
  // The probe itself failed, which makes every other field on the row unknown rather than bad.
  if (usage.ok === false) return undefined;
  const quota = quotaFromUsage(usage);
  // A credential problem is not a quota problem, and the remedy is a human logging in.
  if (quota.authOk === false) return undefined;
  if (quota.atLimit === true) return `the usage feed measured ${usage.agent} at its limit${measurement(usage)}`;
  if (
    quota.unavailable === true &&
    quota.unavailableReason !== undefined &&
    EXHAUSTION_REASONS.has(quota.unavailableReason)
  )
    return `the provider reports ${usage.agent} unavailable for ${quota.unavailableReason.replaceAll('_', ' ')}${measurement(usage)}`;
  return undefined;
}

/**
 * Whether an account has confirmed headroom, and the number it was confirmed at.
 *
 * A union rather than a nullable reason plus a separate lookup, so a caller cannot end up holding a
 * confirmation without the measurement that produced it — the measurement is what the selector ranks
 * on and what the report has to be able to quote.
 */
export type HeadroomVerdict =
  | { readonly confirmed: true; readonly spentPercent: number }
  | { readonly confirmed: false; readonly reason: string };

/**
 * Whether this account may receive a session.
 *
 * Three separate demands, none of which the other two imply: the feed must have scored the account
 * at all, it must have scored it as usable with `atLimit` explicitly false, and it must have produced
 * a number that is below the ceiling. An account whose consumption is simply unknown fails the third
 * even though it passes the first two, and that is the case this exists for — an unmeasured account
 * used to sort ahead of every measured one because absence read as zero.
 */
export function headroom(usage: AccountUsage | undefined, ceilingPercent: number): HeadroomVerdict {
  if (usage === undefined) return { confirmed: false, reason: 'the usage feed has no reading for this account' };
  if (!confirmedUsableAccount(usage))
    return {
      confirmed: false,
      reason: unusableAccountReason(usage) ?? 'the usage feed has not confirmed this account can take work',
    };
  const spent = spentPercent(usage);
  if (spent === undefined)
    return { confirmed: false, reason: 'the usage feed reports no measured consumption for this account' };
  if (spent >= ceilingPercent)
    return {
      confirmed: false,
      reason: `measured at ${spent}% of its tighter window, which is not below the ${ceilingPercent}% headroom ceiling`,
    };
  return { confirmed: true, spentPercent: spent };
}

/**
 * Why the usage snapshot may not be acted on, or `undefined` when it is fresh enough.
 *
 * An ABSENT snapshot instant is refused rather than treated as "now". The feed reports one only once
 * it has actually collected, so a missing instant means nothing has ever been read — the single most
 * dangerous input to a destructive operation, and the one a benign default would erase.
 */
export function snapshotRefusal(snapshotAt: number | undefined, nowMs: number, ceilingMs: number): string | undefined {
  if (snapshotAt === undefined)
    return 'the usage feed has never collected a snapshot, so no account can be shown to be out of tokens';
  const ageMs = nowMs - snapshotAt;
  if (ageMs > ceilingMs)
    return `the usage snapshot is ${Math.round(ageMs / 1_000)}s old, past the ${Math.round(ceilingMs / 1_000)}s freshness ceiling`;
  return undefined;
}
