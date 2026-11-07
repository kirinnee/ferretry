/**
 * v4 Usage files (4.291.5). A LOCAL copy on purpose: the product has no v4 reader.
 *
 * - `state/budget-holds.json` (`packages/daemon/src/adapters/budget/ports.ts` `HoldsSchema`, path
 *   `bin/modules/usage.ts:187`): `{ [login]: {period, level, limitUsd, resetsAtMs, timeZone} }`, no version. v4 reads
 *   it with ONE strict parse at boot (`readBudgetHoldsSync`): a missing or garbled file is no holds at all.
 * - `state/budget-told.json` (same file, `FileBudgetTold`, path `bin/modules/usage.ts:287`): a JSON list of
 *   `<login>|<period>|<period start ISO>` keys (`lib/budget/service.ts:110`), no version; garbled reads as `[]`.
 * - `config/daemon.json` keys `analyticsPricing` and `analyticsPricingSources` (`lib/runtime/config.ts:441,450`, both
 *   default `[]`): the owner's rate catalog and the feeds it may sync from. The rest of `daemon.json` is not Usage's.
 *   v4's rate schema is a UNION of today's canonical row and an older spelling (`ratesUsdMicrosPerMillion`,
 *   `packages/protocol/src/lib/analytics-pricing.ts:253-324`) that v4 rewrote on read; v5 accepts the canonical row
 *   only, so the older spelling is converted here with v4's own transform, vendored below.
 * - `fleet/credentials/<login>/usage.json`: the last passive rate-limit reading (`fy statusline` / the Codex rollout
 *   scan). It sits in a harness sign-in folder, so this tool only ever `lstat`s it (see `src/steps/usage.ts`).
 *
 * None of these holds a runtime uuid (holds and told keys are LOGIN ids), so M7's re-key has nothing to do here; the
 * one v4 usage store keyed by runtime is `state/index/analytics.sqlite`, a cache v5 rebuilds.
 */
import { z } from 'zod';
import { isRecord } from './documents.ts';

export const V4_BUDGET_HOLDS = 'state/budget-holds.json';
export const V4_BUDGET_TOLD = 'state/budget-told.json';
export const V4_DAEMON_CONFIG = 'config/daemon.json';
export const V4_ANALYTICS_INDEX = 'state/index/analytics.sqlite';

/** v4's `HoldsSchema`, verbatim: one bad entry makes the whole file read as no holds. */
export const V4BudgetHolds = z.record(
  z.string(),
  z.strictObject({
    period: z.enum(['daily', 'weekly']),
    level: z.enum(['over_trigger', 'over_hard']),
    limitUsd: z.number().finite().positive(),
    resetsAtMs: z.number().finite(),
    timeZone: z.string().min(1),
  }),
);

/** v4's `ToldSchema`, verbatim. */
export const V4BudgetTold = z.array(z.string());

/** The two pricing keys of `daemon.json`, each `[]` when absent (v4's defaults). Their rows are checked by v5. */
export const V4PricingKeys = z.looseObject({
  analyticsPricing: z.array(z.unknown()).default([]),
  analyticsPricingSources: z.array(z.unknown()).default([]),
});

// ─── v4's older rate spelling, vendored from bb89d054d `packages/protocol/src/lib/analytics-pricing.ts` ────────────

/** v4's `LegacyInstantSchema`: anything `Date.parse` reads, canonicalised to an ISO instant. */
const LegacyInstant = z
  .string()
  .trim()
  .refine(value => Number.isFinite(Date.parse(value)), 'must be a valid instant')
  .transform(value => new Date(value).toISOString());

const UsdMicros = z.number().int().nonnegative().safe();
const Text = z.string().trim().min(1).max(128);

/**
 * v4's `LegacyAnalyticsPricingRateSchema` and its transform to the canonical row: the currency it always meant,
 * `manual` provenance, `null` for the slots the old shape could not express. Never a guess about a price.
 */
export const V4LegacyPricingRate = z
  .strictObject({
    pricingKey: Text,
    modelId: Text,
    aliases: z.array(Text).max(32).default([]),
    provider: z.string(),
    ratesUsdMicrosPerMillion: z.strictObject({
      input: UsdMicros,
      cachedRead: UsdMicros,
      cacheWrite: UsdMicros.optional(),
      cacheWrite5m: UsdMicros.optional(),
      cacheWrite1h: UsdMicros.optional(),
      output: UsdMicros,
    }),
    verifiedAt: LegacyInstant,
    validFrom: LegacyInstant,
    validThrough: LegacyInstant.optional(),
  })
  .transform(rate => ({
    pricingKey: rate.pricingKey,
    modelId: rate.modelId,
    aliases: rate.aliases,
    provider: rate.provider,
    currency: 'USD' as const,
    rates: {
      input: rate.ratesUsdMicrosPerMillion.input,
      output: rate.ratesUsdMicrosPerMillion.output,
      cachedInput: rate.ratesUsdMicrosPerMillion.cachedRead,
      cacheWrite: rate.ratesUsdMicrosPerMillion.cacheWrite ?? null,
      cacheWrite5m: rate.ratesUsdMicrosPerMillion.cacheWrite5m ?? null,
      cacheWrite1h: rate.ratesUsdMicrosPerMillion.cacheWrite1h ?? null,
      reasoning: null,
      image: null,
      tool: null,
    },
    source: { kind: 'manual' as const },
    validFrom: rate.validFrom,
    validThrough: rate.validThrough ?? null,
    verifiedAt: rate.verifiedAt,
    lastSyncedAt: null,
  }));

/**
 * One catalog row as v5 must see it: a row in the older spelling is converted with v4's own transform; any other row
 * is passed on untouched for v5's schema to judge. `undefined` when an older-spelling row does not parse even as that.
 */
export function canonicalRateRow(row: unknown): unknown {
  if (!isRecord(row) || !('ratesUsdMicrosPerMillion' in row)) return row;
  const legacy = V4LegacyPricingRate.safeParse(row);
  return legacy.success ? legacy.data : undefined;
}
