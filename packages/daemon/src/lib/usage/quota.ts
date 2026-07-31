import type { AccountUsage, SessionState } from '@ferretry/protocol';
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
  if (authMode === 'oauth') return 'run `fy fleet login` for this account';
  if (authMode === 'api-key') return "rotate this account's API key in the secrets file, then run `fy fleet apply`";
  return 'for an API-key account rotate its secret then run `fy fleet apply`; for an OAuth account run `fy fleet login`';
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

/**
 * Project one feed record into the wire shape clients consume. It reuses {@link quotaFromUsage} so
 * the API can never disagree with the session state over the same account.
 */
export function usageAccountView(account: AccountUsage): { agent: string } & SessionQuota {
  const { resetAt: _resetAt, ...quota } = quotaFromUsage(account);
  return { agent: account.agent, ...quota };
}

/**
 * The session-state fields derived from a quota. Every value is explicit — an account that has
 * just become invalid must clear stale percentages rather than keep displaying the old numbers.
 */
export interface SessionUsageStatePatch {
  readonly usage5hPercent: number | undefined;
  readonly usageWeeklyPercent: number | undefined;
  readonly usage5hResetAt: number | undefined;
  readonly usageWeeklyResetAt: number | undefined;
  readonly usageAtLimit: boolean | undefined;
  readonly usageAuthOk: boolean | undefined;
}

export function usageStateFromQuota(quota: SessionQuota): SessionUsageStatePatch {
  const authenticated = quota.authOk !== false;
  return {
    usage5hPercent: authenticated ? quota.fiveHourPercent : undefined,
    usageWeeklyPercent: authenticated ? quota.weeklyPercent : undefined,
    usage5hResetAt: authenticated ? quota.fiveHourResetAt : undefined,
    usageWeeklyResetAt: authenticated ? quota.weeklyResetAt : undefined,
    usageAtLimit: authenticated ? quota.atLimit : undefined,
    usageAuthOk: quota.authOk,
  };
}

/** Defined usage fields for event payloads; unknown values stay omitted rather than sent as null. */
export function usageEventData(state: SessionUsageDisplay): Record<string, number | boolean> {
  return {
    ...(state.usage5hPercent !== undefined ? { usage5hPercent: state.usage5hPercent } : {}),
    ...(state.usageWeeklyPercent !== undefined ? { usageWeeklyPercent: state.usageWeeklyPercent } : {}),
    ...(state.usage5hResetAt !== undefined ? { usage5hResetAt: state.usage5hResetAt } : {}),
    ...(state.usageWeeklyResetAt !== undefined ? { usageWeeklyResetAt: state.usageWeeklyResetAt } : {}),
    ...(state.usageAtLimit !== undefined ? { usageAtLimit: state.usageAtLimit } : {}),
    ...(state.usageAuthOk !== undefined ? { usageAuthOk: state.usageAuthOk } : {}),
  };
}

/** The usage fields any renderer needs — a session state satisfies it structurally. */
export type SessionUsageDisplay = Pick<
  SessionState,
  'usage5hPercent' | 'usageWeeklyPercent' | 'usage5hResetAt' | 'usageWeeklyResetAt' | 'usageAtLimit' | 'usageAuthOk'
>;

/** Long form for a detail view: `5h 12% · wk 40% · AT LIMIT`, or nothing when all is unknown. */
export function usageQuotaLabel(state: SessionUsageDisplay): string | undefined {
  if (state.usageAuthOk === false) return 'AUTH REQUIRED';
  const parts = [
    state.usage5hPercent === undefined ? undefined : `5h ${state.usage5hPercent}%`,
    state.usageWeeklyPercent === undefined ? undefined : `wk ${state.usageWeeklyPercent}%`,
    state.usageAtLimit === true ? 'AT LIMIT' : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Column form for a dense listing: `12%/40%!`, with an em dash wherever a number is unknown. */
export function compactUsageQuota(state: SessionUsageDisplay): string {
  if (state.usageAuthOk === false) return 'AUTH!';
  if (state.usage5hPercent === undefined && state.usageWeeklyPercent === undefined) return '—';
  const fiveHour = state.usage5hPercent === undefined ? '—' : `${state.usage5hPercent}%`;
  const weekly = state.usageWeeklyPercent === undefined ? '—' : `${state.usageWeeklyPercent}%`;
  return `${fiveHour}/${weekly}${state.usageAtLimit === true ? '!' : ''}`;
}
