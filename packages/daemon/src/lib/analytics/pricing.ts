import {
  normalizeAnalyticsModelIdentity,
  type AnalyticsModelAliasGroup,
  type AnalyticsModelIdentity,
} from './model-identity.ts';

export type AnalyticsPricingProvider = 'openai' | 'anthropic';

export interface AnalyticsPricingRates {
  readonly input: number;
  readonly cachedRead: number;
  readonly cacheWrite?: number;
  readonly cacheWrite5m?: number;
  readonly cacheWrite1h?: number;
  readonly output: number;
}

export interface AnalyticsPricingRate {
  readonly pricingKey: string;
  readonly modelId: string;
  readonly aliases: readonly string[];
  readonly provider: AnalyticsPricingProvider;
  /** Integer USD micros per million tokens. */
  readonly ratesUsdMicrosPerMillion: AnalyticsPricingRates;
  readonly verifiedAt: string;
  readonly validFrom: string;
  readonly validThrough?: string;
}

export interface AnalyticsTokenUsage {
  /** Transcript evidence; never substitute the selected/display model. */
  readonly pricingModel: string | null | undefined;
  readonly createdAt: string | null | undefined;
  /** Gross input including cache reads and writes. */
  readonly inputTokens: number | null | undefined;
  readonly cachedInputTokens: number | null | undefined;
  readonly cacheWriteInputTokens: number | null | undefined;
  readonly cacheWrite5mInputTokens?: number | null;
  readonly cacheWrite1hInputTokens?: number | null;
  readonly outputTokens: number | null | undefined;
}

export interface EffectiveAnalyticsPricingSnapshot {
  readonly pricingKey: string;
  readonly modelId: string;
  readonly provider: AnalyticsPricingProvider;
  readonly ratesUsdMicrosPerMillion: AnalyticsPricingRates;
  readonly verifiedAt: string;
  readonly validFrom: string;
  readonly validThrough: string | null;
}

export type AnalyticsPricingUnknownReason =
  | 'missing_pricing_model'
  | 'invalid_created_at'
  | 'unknown_pricing_model'
  | 'pricing_outside_validity_window'
  | 'incomplete_token_counts'
  | 'invalid_token_counts'
  | 'negative_uncached_input'
  | 'missing_anthropic_cache_write_split'
  | 'inconsistent_anthropic_cache_write_split'
  | 'invalid_rate_table'
  | 'cost_out_of_range';

export type AnalyticsUsagePricingSnapshot =
  | {
      readonly kind: 'priced';
      readonly identity: AnalyticsModelIdentity;
      readonly rate: EffectiveAnalyticsPricingSnapshot;
      readonly equivalentApiCostUsdMicros: number;
    }
  | {
      readonly kind: 'unpriced';
      readonly identity: AnalyticsModelIdentity | null;
      readonly reason: AnalyticsPricingUnknownReason;
    };

const TOKENS_PER_MILLION = 1_000_000n;
const HALF_MILLION = TOKENS_PER_MILLION / 2n;

function aliasesFrom(catalog: readonly AnalyticsPricingRate[]): AnalyticsModelAliasGroup[] {
  return catalog.map(entry => ({ modelId: entry.modelId, aliases: entry.aliases }));
}

function parseInstant(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function isTokenCount(value: number | null | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0;
}

function ratesAreValid(rates: AnalyticsPricingRates): boolean {
  return [rates.input, rates.cachedRead, rates.output, rates.cacheWrite, rates.cacheWrite5m, rates.cacheWrite1h]
    .filter((rate): rate is number => rate !== undefined)
    .every(rate => Number.isSafeInteger(rate) && rate >= 0);
}

function matchingRate(
  identity: AnalyticsModelIdentity,
  createdAt: number,
  catalog: readonly AnalyticsPricingRate[],
): AnalyticsPricingRate | null {
  return (
    catalog
      .filter(entry => normalizeAnalyticsModelIdentity(entry.modelId)?.modelId === identity.modelId)
      .filter(entry => {
        const from = parseInstant(entry.validFrom);
        const through = parseInstant(entry.validThrough);
        return (
          from !== null &&
          createdAt >= from &&
          (entry.validThrough === undefined || (through !== null && createdAt <= through))
        );
      })
      .sort((left, right) => Date.parse(right.validFrom) - Date.parse(left.validFrom))[0] ?? null
  );
}

function unknown(
  identity: AnalyticsModelIdentity | null,
  reason: AnalyticsPricingUnknownReason,
): AnalyticsUsagePricingSnapshot {
  return { kind: 'unpriced', identity, reason };
}

function tokenCost(
  usage: AnalyticsTokenUsage,
  rate: AnalyticsPricingRate,
): { kind: 'known'; value: number } | { kind: 'unknown'; reason: AnalyticsPricingUnknownReason } {
  const counts = [usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens, usage.outputTokens];
  if (counts.some(value => value === null || value === undefined)) {
    return { kind: 'unknown', reason: 'incomplete_token_counts' };
  }
  if (!counts.every(isTokenCount)) return { kind: 'unknown', reason: 'invalid_token_counts' };
  if (!ratesAreValid(rate.ratesUsdMicrosPerMillion)) {
    return { kind: 'unknown', reason: 'invalid_rate_table' };
  }

  const input = usage.inputTokens!;
  const cachedRead = usage.cachedInputTokens!;
  const cacheWrite = usage.cacheWriteInputTokens!;
  const output = usage.outputTokens!;
  const uncached = input - cachedRead - cacheWrite;
  if (uncached < 0) return { kind: 'unknown', reason: 'negative_uncached_input' };

  const rates = rate.ratesUsdMicrosPerMillion;
  let numerator =
    BigInt(uncached) * BigInt(rates.input) +
    BigInt(cachedRead) * BigInt(rates.cachedRead) +
    BigInt(output) * BigInt(rates.output);

  if (rate.provider === 'anthropic' && cacheWrite > 0) {
    if (
      usage.cacheWrite5mInputTokens === null ||
      usage.cacheWrite5mInputTokens === undefined ||
      usage.cacheWrite1hInputTokens === null ||
      usage.cacheWrite1hInputTokens === undefined
    ) {
      return { kind: 'unknown', reason: 'missing_anthropic_cache_write_split' };
    }
    if (!isTokenCount(usage.cacheWrite5mInputTokens) || !isTokenCount(usage.cacheWrite1hInputTokens)) {
      return { kind: 'unknown', reason: 'invalid_token_counts' };
    }
    if (usage.cacheWrite5mInputTokens + usage.cacheWrite1hInputTokens !== cacheWrite) {
      return { kind: 'unknown', reason: 'inconsistent_anthropic_cache_write_split' };
    }
    if (rates.cacheWrite5m === undefined || rates.cacheWrite1h === undefined) {
      return { kind: 'unknown', reason: 'invalid_rate_table' };
    }
    numerator +=
      BigInt(usage.cacheWrite5mInputTokens) * BigInt(rates.cacheWrite5m) +
      BigInt(usage.cacheWrite1hInputTokens) * BigInt(rates.cacheWrite1h);
  } else if (cacheWrite > 0) {
    if (rates.cacheWrite === undefined) return { kind: 'unknown', reason: 'invalid_rate_table' };
    numerator += BigInt(cacheWrite) * BigInt(rates.cacheWrite);
  }

  const rounded = (numerator + HALF_MILLION) / TOKENS_PER_MILLION;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: 'unknown', reason: 'cost_out_of_range' };
  return { kind: 'known', value: Number(rounded) };
}

/**
 * Resolve and calculate pricing exactly once at ingestion time. The returned
 * rate is a complete immutable snapshot suitable for durable storage, so later
 * catalog edits cannot rewrite historical costs.
 */
export function snapshotAnalyticsUsagePricing(
  usage: AnalyticsTokenUsage,
  catalog: readonly AnalyticsPricingRate[],
): AnalyticsUsagePricingSnapshot {
  const identity = normalizeAnalyticsModelIdentity(usage.pricingModel, aliasesFrom(catalog));
  if (identity === null) return unknown(null, 'missing_pricing_model');

  const createdAt = parseInstant(usage.createdAt);
  if (createdAt === null) return unknown(identity, 'invalid_created_at');

  const modelRates = catalog.filter(
    entry => normalizeAnalyticsModelIdentity(entry.modelId)?.modelId === identity.modelId,
  );
  if (modelRates.length === 0) return unknown(identity, 'unknown_pricing_model');

  const rate = matchingRate(identity, createdAt, catalog);
  if (rate === null) return unknown(identity, 'pricing_outside_validity_window');

  const cost = tokenCost(usage, rate);
  if (cost.kind === 'unknown') return unknown(identity, cost.reason);

  return {
    kind: 'priced',
    identity,
    rate: {
      pricingKey: rate.pricingKey,
      modelId: normalizeAnalyticsModelIdentity(rate.modelId)!.modelId,
      provider: rate.provider,
      ratesUsdMicrosPerMillion: { ...rate.ratesUsdMicrosPerMillion },
      verifiedAt: rate.verifiedAt,
      validFrom: rate.validFrom,
      validThrough: rate.validThrough ?? null,
    },
    equivalentApiCostUsdMicros: cost.value,
  };
}
