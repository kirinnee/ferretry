/** Account health predicates (today's `usage/account-health.ts`, owned by Usage; the failover selector reads them). */


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
