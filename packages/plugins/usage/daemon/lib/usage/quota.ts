import type { AccountUsage } from '../../../contract/index.ts';
import type { AccountAuthMode, SessionQuota } from './types.ts';

/**
 * The achievable remedy for an account the feed reports as auth-failed.
 *
 * The source keyed this off a hardcoded set of provider names, so every provider added afterwards
 * silently fell into the API-key branch and was told to rotate a key it does not have. The
 * authentication mode is declared by fleet configuration, so it is taken as input here: an OAuth
 * account is told to log in, an API-key account is told to rotate its secret, and an account whose
 * mode is genuinely unknown is given both paths rather than a confident guess.
 */
export function authFailureRemedy(authMode?: AccountAuthMode): string {
  if (authMode === 'oauth') return "sign this runtime's login in again with `fy credential signin <login>`";
  if (authMode === 'api-key') return "replace the secret this runtime's login reads with `fy secret set <NAME>`";
  return 'for a login from the environment replace its secret with `fy secret set <NAME>`; for any other login run `fy credential signin <login>`';
}

const percent = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;

const timestamp = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/** Actionable provider-down wording shared by launch preflight and status paths. */
export function providerUnavailableDetail(quota: SessionQuota): string {
  const reason =
    quota.unavailableReason === 'cooldown'
      ? 'every provider credential is cooling down'
      : quota.unavailableReason === 'spend_limit'
        ? 'the monthly spend limit was reached'
        : quota.unavailableReason === 'auth'
          ? 'the provider rejected every credential'
          : quota.unavailableReason === 'no_credentials'
            ? 'the provider has no active credentials'
            : 'the provider is unavailable';
  const retry = quota.retryAt === undefined ? '' : `; retry after ${new Date(quota.retryAt).toISOString()}`;
  return `${reason}${retry}`;
}

/**
 * Normalize one account row without ever turning absent or errored data into `0%`.
 *
 * Three rules hold the whole surface together: a transport or probe failure (`ok:false`) leaves
 * every number unknown rather than zero; only an explicit `authOk:false` is authentication
 * evidence; and runtime availability is carried independently of the numerical subscription
 * windows, because a reachable account can be at its limit and an unreachable one can have a
 * perfectly good quota.
 */
export function quotaFromUsage(account: AccountUsage): SessionQuota {
  const authOk = account.authOk;
  const feedOk = account.ok !== false;
  const numerical = feedOk && account.usageBased !== false && authOk !== false;
  const availability = feedOk ? account.availability : undefined;
  const unavailable = feedOk && typeof account.unavailable === 'boolean' ? account.unavailable : undefined;
  const reason = unavailable === true ? account.unavailableReason : undefined;
  const retryAt = availability === undefined ? undefined : timestamp(account.retryAt);
  const availabilityKnown = availability !== undefined || unavailable !== undefined;
  const fiveHourPercent = numerical ? percent(account.fiveHourPercent) : undefined;
  const weeklyPercent = numerical ? percent(account.weeklyPercent) : undefined;
  const fiveHourResetAt = numerical ? timestamp(account.fiveHourResetAt) : undefined;
  const weeklyResetAt = numerical ? timestamp(account.weeklyResetAt) : undefined;
  const resets = [fiveHourResetAt, weeklyResetAt].filter((value): value is number => value !== undefined);
  return {
    ...(typeof account.usageBased === 'boolean' ? { usageBased: account.usageBased } : {}),
    ...(availability !== undefined ? { availability } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
    ...(reason !== undefined ? { unavailableReason: reason } : {}),
    ...(retryAt !== undefined ? { retryAt } : {}),
    ...((numerical || availabilityKnown) && typeof account.atLimit === 'boolean' ? { atLimit: account.atLimit } : {}),
    ...(authOk !== undefined ? { authOk } : {}),
    ...(account.provider !== undefined ? { provider: account.provider } : {}),
    ...(fiveHourPercent !== undefined ? { fiveHourPercent } : {}),
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
    ...(fiveHourResetAt !== undefined ? { fiveHourResetAt } : {}),
    ...(weeklyResetAt !== undefined ? { weeklyResetAt } : {}),
    ...(resets.length > 0 ? { resetAt: Math.min(...resets) } : {}),
  };
}
