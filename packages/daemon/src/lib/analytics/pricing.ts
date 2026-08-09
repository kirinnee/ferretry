import {
  type ANALYTICS_PRICING_RATE_UNITS,
  type AnalyticsModelAliasGroup,
  type AnalyticsModelIdentity,
  type AnalyticsPricingCurrency,
  type AnalyticsPricingRate,
  type AnalyticsPricingRateSlot,
  type AnalyticsPricingRates,
  type AnalyticsPricingRateUnit,
  type AnalyticsPricingSource,
  normalizeAnalyticsModelIdentity,
} from '@ferretry/protocol';

export type {
  AnalyticsPricingCurrency,
  AnalyticsPricingProvider,
  AnalyticsPricingRate,
  AnalyticsPricingRates,
  AnalyticsPricingRateUnit,
  AnalyticsPricingSource,
} from '@ferretry/protocol';

/**
 * The rate numbers frozen onto a priced session, in the shape the index already stores.
 *
 * DELIBERATELY NOT the catalog's rates object. A stored row is evidence of what a session was
 * actually charged at, and the columns holding it were written by earlier boots; widening them to
 * follow every catalog slot is a schema migration, not a rename. The catalog stays the one place a
 * price is DECIDED, and this is the narrower record of what that decision produced for the slots this
 * build knows how to multiply.
 *
 * `image` and `tool` are catalog facts this build deliberately does NOT carry here. Ingestion has no
 * billable image or tool-call evidence to multiply them by — no transcript figure counts either — so
 * writing them onto a priced session would state that they were applied when nothing applied them,
 * and inventing a count to apply them to would be a heuristic charging an operator real money.
 */
export interface EffectiveAnalyticsPricingRates {
  readonly input: number;
  readonly cachedRead: number;
  readonly cacheWrite?: number;
  readonly cacheWrite5m?: number;
  readonly cacheWrite1h?: number;
  readonly reasoning?: number;
  readonly output: number;
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
  /** Gross output including any separately billed reasoning tokens. */
  readonly outputTokens: number | null | undefined;
  /**
   * The part of the output a harness named as reasoning, or `null` when it named none.
   *
   * A SUBSET OF `outputTokens`, exactly as `cachedInputTokens` is a subset of `inputTokens`. Null is
   * not zero here: null means the transcript made no reasoning claim, so the whole output is charged
   * at the output rate, and zero means the harness stated there was none.
   */
  readonly reasoningTokens?: number | null;
  /**
   * Some usage records named reasoning while another record in the same Codex session did not.
   * The known subset cannot be priced as the whole session, but the ordinary token totals remain
   * useful and must not be discarded with it.
   */
  readonly reasoningTokensIncomplete?: boolean;
}

/**
 * The stored slots, each mapped to the catalog slot it projects.
 *
 * A MAPPED TYPE, not a list: adding a stored slot without saying which catalog slot it comes from is
 * a compile error here rather than a column nobody can explain. `TokenRateSlot` narrows the values to
 * the slots the protocol denominates per million tokens, so mapping a stored rate onto `image` or
 * `tool` — which are counted in images and calls, not tokens — cannot compile either.
 */
type TokenRateSlot = {
  [S in AnalyticsPricingRateSlot]: (typeof ANALYTICS_PRICING_RATE_UNITS)[S] extends 'million_tokens' ? S : never;
}[AnalyticsPricingRateSlot];

const STORED_RATE_SLOTS = {
  input: 'input',
  cachedRead: 'cachedInput',
  cacheWrite: 'cacheWrite',
  cacheWrite5m: 'cacheWrite5m',
  cacheWrite1h: 'cacheWrite1h',
  reasoning: 'reasoning',
  output: 'output',
} as const satisfies { readonly [K in keyof Required<EffectiveAnalyticsPricingRates>]: TokenRateSlot };

/**
 * The one denomination every stored rate is expressed in.
 *
 * Written onto the snapshot rather than assumed by whatever reads it: a row states the unit its
 * numbers are in, so nothing downstream has to know that this build only ever multiplies per-million
 * token rates. `STORED_RATE_SLOTS` is what keeps the claim true.
 */
const ANALYTICS_STORED_RATE_UNIT: AnalyticsPricingRateUnit = 'million_tokens';

export interface EffectiveAnalyticsPricingSnapshot {
  readonly pricingKey: string;
  readonly modelId: string;
  readonly provider: AnalyticsPricingRate['provider'];
  /** What the amounts below are money IN. Only `USD` is supported, and it is recorded, not assumed. */
  readonly currency: AnalyticsPricingCurrency;
  /** What the amounts below are money PER. Every stored slot is denominated per million tokens. */
  readonly rateUnit: AnalyticsPricingRateUnit;
  readonly ratesUsdMicrosPerMillion: EffectiveAnalyticsPricingRates;
  /** Whether a person entered this price or a provider feed supplied it, and from where. */
  readonly source: AnalyticsPricingSource;
  /** When a provider feed last supplied these numbers; always null for a manual entry. */
  readonly lastSyncedAt: string | null;
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
  | 'negative_non_reasoning_output'
  | 'incomplete_reasoning_counts'
  | 'missing_anthropic_cache_write_split'
  | 'inconsistent_anthropic_cache_write_split'
  | 'missing_reasoning_rate'
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

/**
 * The catalog read as "which spellings name the same model".
 *
 * Exported because the fold needs the same answer this file does. Deciding whether a session ran
 * under one model or several is the same identity question as looking a price up, and two places
 * answering it from different evidence is how a single-model session came back as a mixed one.
 */
export function analyticsCatalogAliasGroups(catalog: readonly AnalyticsPricingRate[]): AnalyticsModelAliasGroup[] {
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
  return Object.values(rates)
    .filter((rate): rate is number => rate !== null)
    .every(rate => Number.isSafeInteger(rate) && rate >= 0);
}

/**
 * Project the catalog's rates onto the narrower record a priced session keeps.
 *
 * A slot the catalog states as `null` is left OFF the stored record rather than written as a zero:
 * "this model has no cache write charge" and "this model's cache writes are free" are different
 * claims, and a row that turned the first into the second would total up without complaint.
 */
function storedRates(rates: AnalyticsPricingRates): EffectiveAnalyticsPricingRates {
  return {
    input: rates[STORED_RATE_SLOTS.input],
    cachedRead: rates[STORED_RATE_SLOTS.cachedRead],
    output: rates[STORED_RATE_SLOTS.output],
    ...(rates.cacheWrite === null ? {} : { cacheWrite: rates.cacheWrite }),
    ...(rates.cacheWrite5m === null ? {} : { cacheWrite5m: rates.cacheWrite5m }),
    ...(rates.cacheWrite1h === null ? {} : { cacheWrite1h: rates.cacheWrite1h }),
    ...(rates.reasoning === null ? {} : { reasoning: rates.reasoning }),
  };
}

/**
 * The provenance COPIED onto the snapshot, never the catalog's own object.
 *
 * A stored row is a frozen record of what priced it, and `readonly` is a compile-time claim about
 * one reference — it does not stop the caller who still owns the catalog entry from editing the
 * object both now point at. Sharing it would let an operator's later catalog edit reach backwards
 * into a snapshot taken months earlier, which is the exact rewrite ingest-time pricing exists to
 * prevent. Rebuilt per branch rather than spread, so a member the union grows must be handled here.
 */
function storedSource(source: AnalyticsPricingSource): AnalyticsPricingSource {
  return source.kind === 'manual'
    ? { kind: 'manual' }
    : { kind: 'provider_sync', provider: source.provider, sourceUrl: source.sourceUrl };
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
          (entry.validThrough === null || (through !== null && createdAt <= through))
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
  if (!ratesAreValid(rate.rates)) {
    return { kind: 'unknown', reason: 'invalid_rate_table' };
  }

  const input = usage.inputTokens!;
  const cachedRead = usage.cachedInputTokens!;
  const cacheWrite = usage.cacheWriteInputTokens!;
  const output = usage.outputTokens!;
  const uncached = input - cachedRead - cacheWrite;
  if (uncached < 0) return { kind: 'unknown', reason: 'negative_uncached_input' };

  if (usage.reasoningTokensIncomplete === true) {
    return { kind: 'unknown', reason: 'incomplete_reasoning_counts' };
  }

  /**
   * Reasoning is a SUBSET of the output total, so it is subtracted before the output rate is applied
   * — the same arithmetic the cached and cache-written parts of the input already get.
   *
   * Charging the full output AND the reasoning subset would bill the same tokens twice. A harness
   * that named no reasoning figure gives `null`, which is not a claim of zero: the whole output is
   * then charged at the output rate, which is what a build with no reasoning evidence must do.
   */
  const reasoning = usage.reasoningTokens ?? 0;
  if (!isTokenCount(reasoning)) return { kind: 'unknown', reason: 'invalid_token_counts' };
  const nonReasoningOutput = output - reasoning;
  if (nonReasoningOutput < 0) return { kind: 'unknown', reason: 'negative_non_reasoning_output' };

  const rates = rate.rates;
  let numerator =
    BigInt(uncached) * BigInt(rates.input) +
    BigInt(cachedRead) * BigInt(rates.cachedInput) +
    BigInt(nonReasoningOutput) * BigInt(rates.output);

  if (reasoning > 0) {
    // An operator who has not stated a reasoning rate has not said reasoning is free, and this build
    // will not decide on their behalf that it is charged at the output rate. Refusing names a fact
    // they can supply; guessing puts an unverifiable number on the board.
    if (rates.reasoning === null) return { kind: 'unknown', reason: 'missing_reasoning_rate' };
    numerator += BigInt(reasoning) * BigInt(rates.reasoning);
  }

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
    if (rates.cacheWrite5m === null || rates.cacheWrite1h === null) {
      return { kind: 'unknown', reason: 'invalid_rate_table' };
    }
    numerator +=
      BigInt(usage.cacheWrite5mInputTokens) * BigInt(rates.cacheWrite5m) +
      BigInt(usage.cacheWrite1hInputTokens) * BigInt(rates.cacheWrite1h);
  } else if (cacheWrite > 0) {
    if (rates.cacheWrite === null) return { kind: 'unknown', reason: 'invalid_rate_table' };
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
  const identity = normalizeAnalyticsModelIdentity(usage.pricingModel, analyticsCatalogAliasGroups(catalog));
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
      currency: rate.currency,
      rateUnit: ANALYTICS_STORED_RATE_UNIT,
      ratesUsdMicrosPerMillion: storedRates(rate.rates),
      source: storedSource(rate.source),
      lastSyncedAt: rate.lastSyncedAt,
      verifiedAt: rate.verifiedAt,
      validFrom: rate.validFrom,
      validThrough: rate.validThrough,
    },
    equivalentApiCostUsdMicros: cost.value,
  };
}
