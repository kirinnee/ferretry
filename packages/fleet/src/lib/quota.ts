/**
 * Reading a provider's answer about how much quota an account has spent.
 *
 * ## The one thing this module exists to get right
 *
 * Anthropic reports utilization through **two** sources that use the **same field name** on
 * **different scales**:
 *
 * | source                                             | field                                             | scale    |
 * | -------------------------------------------------- | ------------------------------------------------- | -------- |
 * | `GET /api/oauth/usage` (stored subscription OAuth) | `five_hour.utilization`                           | `0..100` |
 * | `POST /v1/messages` response headers               | `anthropic-ratelimit-unified-5h-utilization`       | `0..1`   |
 *
 * Reading one with the other's rule is a **100× error**, and it is silent in both directions: a
 * healthy account reads as exhausted, or an exhausted one reads as healthy, and the fleet routes
 * around the wrong thing. So the two readings live in two named functions here, each converting to the
 * single public unit — **consumed percent, `0..100`** — at its own boundary, and nowhere else.
 *
 * The tests feed `0.42` and `42` to both readers precisely because each value is wrong under the
 * other's rule: `0.42` is 42% as a fraction and a rounding error as a percentage, and `42` is 42% as a
 * percentage and out of range as a fraction.
 *
 * ## Fail closed
 *
 * A missing, unparseable or out-of-range measurement is **absent**, never zero. Zero is a claim that
 * an account has spent nothing, and a probe that could not read a number is not entitled to make it.
 * `hasQuotaSignal` is how a caller tells "I read 0% of quota used" from "I read nothing" — the
 * distinction the collector needs so a failed probe can never mark an account healthy.
 *
 * Pure throughout: no network, no clock, no credentials. Values in, verdict out.
 */
import type { FleetUsageWindow } from './usage.ts';
import { clampUsagePercent, normalizeResetAt } from './usage.ts';

/** A pair of quota windows, shortest reset horizon first. */
export interface QuotaWindows {
  readonly shortWindow?: FleetUsageWindow;
  readonly longWindow?: FleetUsageWindow;
}

/** What one source said, and whether it said anything measurable at all. */
export interface QuotaReading extends QuotaWindows {
  /**
   * Whether any window carried a real measurement. False means the response was shaped like an answer
   * but contained none, which is a failed reading rather than an idle account.
   */
  readonly hasQuotaSignal: boolean;
  /** The provider itself declared the account over its limit, regardless of any percentage. */
  readonly providerAtLimit: boolean;
}

const window = (usedPercent: number | undefined, resetAt: number | undefined): FleetUsageWindow | undefined =>
  usedPercent === undefined && resetAt === undefined
    ? undefined
    : {
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(resetAt === undefined ? {} : { resetAt }),
      };

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Utilization from the stored-OAuth usage JSON, which is **already a percentage**.
 *
 * Passed through the shared clamp rather than multiplied. A value outside `0..100` is a value this
 * build does not understand, and clamping is what the public contract already promises.
 */
export function percentFromStoredUtilization(value: unknown): number | undefined {
  return typeof value === 'number' ? clampUsagePercent(value) : undefined;
}

/**
 * Utilization from an inference response header, which is a **fraction of one**.
 *
 * Anything above `1` is rejected rather than clamped: `42` here is far more likely to be a percentage
 * that reached the wrong reader than an account at 4200% of its quota, and silently accepting it as
 * 100% would hide exactly the mix-up this module is built to prevent. A rejected value becomes an
 * absent measurement, so the caller reports "unknown" rather than a number it cannot justify.
 *
 * Anthropic has been observed reporting a slightly-over-one utilization (1.01) for a genuinely
 * exhausted window, so the ceiling is generous enough to accept that and still reject a percentage.
 */
export const MAX_UTILIZATION_FRACTION = 2;

export function percentFromUtilizationFraction(value: unknown): number | undefined {
  const fraction = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return undefined;
  if (fraction < 0 || fraction > MAX_UTILIZATION_FRACTION) return undefined;
  return clampUsagePercent(fraction * 100);
}

interface StoredUsageWindow {
  readonly utilization?: unknown;
  readonly resets_at?: unknown;
}

/**
 * The stored subscription usage body: `GET /api/oauth/usage`.
 *
 * `five_hour` is the short window and `seven_day` the long one — named by the provider, so unlike the
 * unnamed case there is nothing to infer from reset horizons.
 */
export function parseStoredUsageBody(body: unknown): QuotaReading {
  const root = asRecord(body);
  const short = asRecord(root.five_hour) as StoredUsageWindow;
  const long = asRecord(root.seven_day) as StoredUsageWindow;

  const shortPercent = percentFromStoredUtilization(short.utilization);
  const longPercent = percentFromStoredUtilization(long.utilization);
  const shortWindow = window(shortPercent, normalizeResetAt(short.resets_at));
  const longWindow = window(longPercent, normalizeResetAt(long.resets_at));

  return {
    ...(shortWindow === undefined ? {} : { shortWindow }),
    ...(longWindow === undefined ? {} : { longWindow }),
    hasQuotaSignal: shortPercent !== undefined || longPercent !== undefined,
    providerAtLimit: false,
  };
}

/** Reading one header by name. `null` and `undefined` both mean the header was not sent. */
export type HeaderLookup = (name: string) => string | null | undefined;

/** The statuses the unified quota headers use. Anything else is not a status this build trusts. */
const QUOTA_STATUSES = new Set(['allowed', 'rejected']);

const HEADER_WINDOWS = { short: '5h', long: '7d' } as const;

function parseHeaderWindow(
  header: HeaderLookup,
  window_: '5h' | '7d',
): { readonly percent?: number; readonly resetAt?: number; readonly rejected: boolean; readonly signal: boolean } {
  const prefix = `anthropic-ratelimit-unified-${window_}-`;
  const status = header(`${prefix}status`)?.trim().toLowerCase();
  const rejected = status !== undefined && QUOTA_STATUSES.has(status) && status === 'rejected';
  const percent = percentFromUtilizationFraction(header(`${prefix}utilization`)?.trim());
  // The reset header is epoch seconds; the shared normalizer handles the unit.
  const resetAt = normalizeResetAt(numberOrUndefined(header(`${prefix}reset`)?.trim()));

  return {
    ...(percent === undefined ? {} : { percent }),
    ...(resetAt === undefined ? {} : { resetAt }),
    rejected,
    // A reset time or an `allowed` label alone proves neither utilization nor headroom. An explicit
    // rejection is a signal even when no percentage came with it.
    signal: percent !== undefined || rejected,
  };
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The unified quota headers an inference response carries.
 *
 * This is the only way to read quota for a token that cannot call the usage endpoint — a declared
 * external OAuth token is inference-scoped and permanently lacks `user:profile`, so
 * `GET /api/oauth/usage` can never work for it.
 */
export function parseQuotaHeaders(header: HeaderLookup): QuotaReading {
  const short = parseHeaderWindow(header, HEADER_WINDOWS.short);
  const long = parseHeaderWindow(header, HEADER_WINDOWS.long);
  const shortWindow = window(short.percent, short.resetAt);
  const longWindow = window(long.percent, long.resetAt);

  return {
    ...(shortWindow === undefined ? {} : { shortWindow }),
    ...(longWindow === undefined ? {} : { longWindow }),
    hasQuotaSignal: short.signal || long.signal,
    providerAtLimit: short.rejected || long.rejected,
  };
}

/**
 * What an HTTP status means about an account, for the two questions that are not the same question.
 *
 * - **`authOk`** — is the credential itself repudiated? Only `401` says yes-it-is-dead. A `403` from an
 *   inference call can be an organization or spend-policy block on a perfectly valid token, so it
 *   leaves the credential verdict *inconclusive* rather than condemning it. Getting this wrong
 *   excluded working accounts from the fleet permanently.
 * - **`unavailable`** — can the account serve work right now? Both `401` and `403` mean no. Leaving
 *   this unset made those accounts read as "usable, just no usage data", so routing kept picking them
 *   and every session launched on one died on arrival.
 *
 * `429` is deliberately absent: a rate-limited response still carries valid quota headers, so it is a
 * **successful** reading, not a failure. The caller checks the headers, not the status.
 */
export interface QuotaHttpVerdict {
  /** Absent when the status says nothing conclusive about the credential. */
  readonly authOk?: boolean;
  readonly unavailable: boolean;
}

export const UNAUTHORIZED = 401;
export const FORBIDDEN = 403;
export const TOO_MANY_REQUESTS = 429;

export function inferenceHttpVerdict(status: number): QuotaHttpVerdict {
  if (status === UNAUTHORIZED) return { authOk: false, unavailable: true };
  if (status === FORBIDDEN) return { unavailable: true };
  return { authOk: true, unavailable: false };
}

/**
 * The same two questions for the read-only usage endpoint, where `403` means something different.
 *
 * A `403` from `GET /api/oauth/usage` only means the token lacks the `user:profile` scope, which is
 * *expected* for an inference-scoped token. It says nothing about whether the account can serve work,
 * so unlike the inference case it must not mark the account unavailable.
 */
export function usageEndpointHttpVerdict(status: number): QuotaHttpVerdict {
  if (status === UNAUTHORIZED) return { authOk: false, unavailable: true };
  if (status === FORBIDDEN) return { unavailable: false };
  return { authOk: true, unavailable: false };
}
