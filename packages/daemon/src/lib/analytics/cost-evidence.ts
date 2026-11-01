/**
 * What a read adds to a stored row: why it has no cost, and what its tokens would cost today.
 *
 * Neither is stored. The first is derived from two columns the row already keeps (its transcript
 * refusal and its pricing snapshot); the second depends on the catalog as it is NOW, which is the
 * point of it — the stored cost is what the rate in force when the session ran made it cost, and this
 * is the same tokens at the rates a person would be charged today.
 *
 * Pure.
 */
import type { AnalyticsRawSession } from '@ferretry/protocol';
import { type AnalyticsPricingRate, snapshotAnalyticsUsagePricing } from './pricing.ts';
import type { AnalyticsStoredSession } from './store.ts';

/** Why a session has no cost, or null when it has one. A reason, never a guess: 'unknown' says none survived. */
export function costGapOf(stored: AnalyticsStoredSession): string | null {
  if (stored.raw.equivalentApiCostUsdMicros !== null) return null;
  if (stored.usageRefusal !== null) return stored.usageRefusal;
  if (stored.pricing?.kind === 'unpriced') return stored.pricing.reason;
  return 'unknown';
}

/**
 * The session's tokens at the catalog's rate in force at `now`, or null when the tokens, the model or
 * a current rate for it is not known. Null is not zero: an unpriced session is not a free one.
 */
export function currentRateCost(
  raw: AnalyticsRawSession,
  catalog: readonly AnalyticsPricingRate[] | undefined,
  now: string,
): number | null {
  if (catalog === undefined || raw.tokens === null) return null;
  const snapshot = snapshotAnalyticsUsagePricing(
    {
      pricingModel: raw.pricingModel,
      createdAt: now,
      inputTokens: raw.inputTokens,
      cachedInputTokens: raw.cachedInputTokens,
      cacheWriteInputTokens: raw.cacheWriteInputTokens,
      cacheWrite5mInputTokens: raw.cacheWrite5mInputTokens,
      cacheWrite1hInputTokens: raw.cacheWrite1hInputTokens,
      outputTokens: raw.outputTokens,
      reasoningTokens: raw.reasoningTokens,
    },
    catalog,
  );
  return snapshot.kind === 'priced' ? snapshot.equivalentApiCostUsdMicros : null;
}

/** The wire row for a stored one: the stored figures, plus the gap and today's cost. */
export function withCostEvidence(
  stored: AnalyticsStoredSession,
  catalog: readonly AnalyticsPricingRate[] | undefined,
  now: string,
): AnalyticsRawSession {
  return {
    ...stored.raw,
    costGap: costGapOf(stored),
    equivalentApiCostCurrentUsdMicros: currentRateCost(stored.raw, catalog, now),
  };
}
