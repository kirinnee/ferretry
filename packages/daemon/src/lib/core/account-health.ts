import type { AccountUsage } from '@ferretry/protocol';
import { providerUnavailableDetail, quotaFromUsage } from '../usage/index.ts';

/**
 * How spent an account is: the tighter of its two windows, or `undefined` when neither is known.
 *
 * The source returned `0` for an account with no data at all, which made an unmeasured account
 * look emptier than every measured one and therefore the first thing a selector reached for.
 * Unknown is not zero here either; callers must say what they want to do about it.
 */
export function spentPercent(usage: AccountUsage | undefined): number | undefined {
  const quota = usage === undefined ? undefined : quotaFromUsage(usage);
  const known = [quota?.fiveHourPercent, quota?.weeklyPercent].filter((value): value is number => value !== undefined);
  return known.length === 0 ? undefined : Math.max(...known);
}

/**
 * Nothing known says this account cannot take work. Absent evidence passes: a human asking for a
 * specific account should not be blocked because the feed has not been collected yet.
 */
export function usableAccount(usage: AccountUsage | undefined): boolean {
  return usage?.unavailable !== true && usage?.atLimit !== true && usage?.authOk !== false;
}

/**
 * Stricter: positively confirmed headroom. Unattended failover acts with no human in the loop, so
 * it may only target an account the feed says is genuinely below its limit and logged in.
 */
export function confirmedUsableAccount(usage: AccountUsage | undefined): boolean {
  return (
    usage !== undefined &&
    usage.ok !== false &&
    usage.unavailable !== true &&
    usage.atLimit === false &&
    usage.authOk !== false
  );
}

/**
 * Why an account cannot take work, in words the reader can act on, or `undefined` while it can.
 *
 * The wording comes from the usage module rather than a second copy of the same reason table — the
 * source carried two, which had already drifted apart in phrasing.
 */
export function unusableAccountReason(usage: AccountUsage | undefined): string | undefined {
  if (usage === undefined) return undefined;
  if (usage.authOk === false) return 'the account is not authenticated';
  if (usage.unavailable === true) return providerUnavailableDetail(quotaFromUsage(usage));
  if (usage.atLimit === true) return 'the account is at its usage limit';
  return undefined;
}

/** The usage row for an executable name, or `undefined` when the feed has nothing for it. */
export function usageForAgent(accounts: readonly AccountUsage[], agent: string): AccountUsage | undefined {
  return accounts.find(account => account.agent === agent);
}
