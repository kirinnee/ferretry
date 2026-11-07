import type { SessionResumeSettings } from './settings.ts';
import type { ResumePolicy, ResumeTarget } from './types.ts';

export type RetryDecision =
  | { readonly kind: 'retry'; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: 'fail'; readonly reason: 'budget-exhausted' | 'not-automatic' };

/**
 * Whether a failed relaunch is retried automatically, and how long the next attempt waits.
 *
 * Only an automatic retry may consume the budget. An operator's resume that fails is a failure they
 * are watching, and silently rescheduling it behind their back would hide the error they asked for.
 *
 * The backoff is capped. Uncapped doubling — which the ancestor used — reaches days by the twentieth
 * attempt, leaving the session parked in `retrying` forever: indistinguishable from a session that
 * has given up, except that nothing ever reports it as failed.
 */
export function planRetry(target: ResumeTarget, policy: ResumePolicy, settings: SessionResumeSettings): RetryDecision {
  const automaticRetry = policy.automatic && policy.expectedStatus === 'retrying';
  if (!automaticRetry) return { kind: 'fail', reason: 'not-automatic' };
  const attempt = target.retryAttempt ?? 0;
  const budget = target.transientRetryBudget ?? 0;
  if (attempt >= budget) return { kind: 'fail', reason: 'budget-exhausted' };
  const next = attempt + 1;
  return { kind: 'retry', attempt: next, delayMs: retryDelayMs(next, settings) };
}

/** The backoff for one attempt: doubling from the base, clamped to the configured ceiling. */
export function retryDelayMs(attempt: number, settings: SessionResumeSettings): number {
  if (attempt <= 0) return settings.retryBackoffBaseMs;
  // Computed on the exponent rather than by doubling a number, so a large attempt cannot overflow
  // to Infinity before the clamp sees it.
  const doublings = Math.min(attempt - 1, 32);
  return Math.min(settings.retryBackoffMaxMs, settings.retryBackoffBaseMs * 2 ** doublings);
}
