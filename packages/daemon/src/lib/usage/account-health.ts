import type { AccountUsage } from '@ferretry/protocol';
import { providerUnavailableDetail, quotaFromUsage } from './quota.ts';

/**
 * Account health lives with the usage feed because the feed is where it comes from.
 *
 * Two consumers read it — the recommender picking a team, and the warden picking a failover target
 * — and the source carried a separate copy of "can this account take work" for each. They had
 * already drifted: one refused an account the other accepted, and their reason tables disagreed in
 * wording. There is one classifier here, and each consumer renders it in its own words.
 */

/**
 * The health facts these predicates read. Deliberately structural and minimal, so both the feed's
 * full {@link AccountUsage} row and the warden's narrower view satisfy it without either module
 * having to know the other exists.
 */
export interface AccountHealthFacts {
  /** `false` when the probe itself failed, which makes every other field unknown rather than good. */
  readonly ok?: boolean;
  readonly authOk?: boolean;
  readonly atLimit?: boolean;
  readonly unavailable?: boolean;
}

/** Why an account cannot take work, as a classification with no wording attached. */
export type AccountHealthProblem = 'auth' | 'unavailable' | 'at-limit';

/**
 * What is wrong with this account, or `undefined` while nothing is.
 *
 * Order is significance, not convenience: rejected credentials outrank everything because they are
 * the only condition a human must act on, and an account that is both unauthenticated and at its
 * limit is still an authentication problem.
 */
export function accountHealthProblem(health: AccountHealthFacts | undefined): AccountHealthProblem | undefined {
  if (health === undefined) return undefined;
  if (health.authOk === false) return 'auth';
  if (health.unavailable === true) return 'unavailable';
  if (health.atLimit === true) return 'at-limit';
  return undefined;
}

/**
 * Nothing known says this account cannot take work. Absent evidence passes: a human asking for a
 * specific account should not be blocked because the feed has not been collected yet, and a feed
 * outage must not disable supervision at the moment it is needed most.
 */
export function usableAccount(health: AccountHealthFacts | undefined): boolean {
  return accountHealthProblem(health) === undefined;
}

/**
 * Stricter: positively confirmed headroom. Unattended work acts with no human in the loop, so it may
 * only target an account the feed actually scored and said is fine — as opposed to one it simply
 * does not know about.
 */
export function confirmedUsableAccount(health: AccountHealthFacts | undefined): boolean {
  return health !== undefined && health.ok !== false && health.atLimit === false && usableAccount(health);
}

/**
 * How spent an account is: the tighter of its two windows, or `undefined` when neither is known.
 *
 * The source returned `0` for an account with no data at all, which made an unmeasured account look
 * emptier than every measured one and therefore the first thing a selector reached for. Unknown is
 * not zero here either; callers must say what they want to do about it.
 */
export function spentPercent(usage: AccountUsage | undefined): number | undefined {
  const quota = usage === undefined ? undefined : quotaFromUsage(usage);
  const known = [quota?.fiveHourPercent, quota?.weeklyPercent].filter((value): value is number => value !== undefined);
  return known.length === 0 ? undefined : Math.max(...known);
}

/** Why an account cannot take work, in words a fleet operator can act on, or `undefined` while it can. */
export function unusableAccountReason(usage: AccountUsage | undefined): string | undefined {
  if (usage === undefined) return undefined;
  switch (accountHealthProblem(usage)) {
    case 'auth':
      return 'the account is not authenticated';
    case 'unavailable':
      return providerUnavailableDetail(quotaFromUsage(usage));
    case 'at-limit':
      return 'the account is at its usage limit';
    default:
      return undefined;
  }
}

/** The usage row for an executable name, or `undefined` when the feed has nothing for it. */
export function usageForAgent(accounts: readonly AccountUsage[], agent: string): AccountUsage | undefined {
  return accounts.find(account => account.agent === agent);
}
