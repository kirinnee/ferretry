import { createHash } from 'node:crypto';
import { type ModelPriceCatalog } from '@ferretry/plugin-logins/contract';
import {
  type AnalyticsPricingRate,
  AnalyticsPricingRateSchema,
  normalizeAnalyticsModelIdentity,
} from '../../../contract/index.ts';

/** The comparable identity of a model id, as a turn's spelling of it would normalize. */
const identityOf = (spelling: string): string => normalizeAnalyticsModelIdentity(spelling)?.modelId ?? spelling;

/**
 * The catalog rates a session can still be charged at once the operator's own rates are laid over them: each one for a
 * model no operator rate names by id or alias. An operator who stated a price stated the whole of it, so mixing their
 * windows with a catalog's would answer "what did this cost" from two authorities at once.
 */
export function unclaimedModelCatalogRates(
  operator: readonly AnalyticsPricingRate[],
  catalog: readonly AnalyticsPricingRate[],
): readonly AnalyticsPricingRate[] {
  const claimed = new Set(operator.flatMap(rate => [rate.modelId, ...rate.aliases].map(identityOf)));
  return catalog.filter(rate => !claimed.has(identityOf(rate.modelId)));
}

/** The whole catalog analytics prices a session from: the operator's rates, then the model catalogs' list prices. */
export function effectiveAnalyticsPricing(
  operator: readonly AnalyticsPricingRate[],
  catalogRates: readonly AnalyticsPricingRate[],
): readonly AnalyticsPricingRate[] {
  return [...operator, ...unclaimedModelCatalogRates(operator, catalogRates)];
}

// ── list prices: the model catalogs' prices as the rates analytics charges ──────────────────────────────────────────────
//
// One rate per model identity. A model several catalogs list (Anthropic's ids are also a gateway's and Vertex AI's) takes
// its MAKER's catalog's price (`anthropic` for an Anthropic-billed model, `openai` for OpenAI's), otherwise the first
// catalog by id, so the answer never depends on file order. Claude Code records the short names `opus`, `sonnet`, `haiku`;
// Anthropic's own catalog pins each to a model, so they are ALIASES of that model (one model, one row, one price). Only the
// MAKER's catalog may do that: a gateway re-pins the same slot names to its own models. Operator rates still win per model
// (`unclaimedModelCatalogRates`). Pure.

/** A list price applies to every session however old: the "equivalent API cost" of the tokens, not the record of a bill. */
const MODEL_CATALOG_PRICE_VALID_FROM = '1970-01-01T00:00:00.000Z';

/** The catalog each maker publishes its own prices in. */
const MAKER_CATALOGS: Readonly<Record<AnalyticsPricingRate['provider'], string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  deepseek: 'deepseek',
  moonshot: 'kimi',
  zai: 'zai',
  minimax: 'minimax',
  alibaba: 'qwen',
};

const HALVES = ['claude', 'codex'] as const;
const TIER_NAMES = ['opus', 'sonnet', 'haiku'] as const;

const micros = (usd: number): number => Math.round(usd * 1_000_000);

/** A stable key under the contract's bound, however long the model id. */
function pricingKey(catalog: string, modelId: string): string {
  const key = `model-catalog:${catalog}:${modelId}`;
  return key.length <= 128
    ? key
    : `model-catalog:${catalog}:${createHash('sha256').update(modelId).digest('hex').slice(0, 32)}`;
}

interface Candidate {
  readonly catalog: string;
  readonly rate: AnalyticsPricingRate;
}

/** Each tier name Anthropic's own catalog pins, mapped to the identity of the model it pins it to. */
function anthropicTierAliases(catalogs: readonly ModelPriceCatalog[]): ReadonlyMap<string, string> {
  const tiers = catalogs.find(catalog => catalog.id === MAKER_CATALOGS.anthropic)?.claude?.tiers;
  const aliases = new Map<string, string>();
  for (const name of TIER_NAMES) {
    const pinned = tiers?.[name];
    if (pinned !== undefined) aliases.set(name, identityOf(pinned));
  }
  return aliases;
}

/** Every catalog model's price as an analytics rate, one per model identity. */
export function modelCatalogPricingRates(catalogs: readonly ModelPriceCatalog[]): readonly AnalyticsPricingRate[] {
  const byIdentity = new Map<string, Candidate[]>();
  for (const catalog of [...catalogs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const half of HALVES) {
      for (const { id: modelId, price } of catalog[half]?.models ?? []) {
        const anthropic = price.provider === 'anthropic';
        // The rate schema is checked again so a rate built here can never be one the analytics contract would refuse.
        const parsed = AnalyticsPricingRateSchema.safeParse({
          pricingKey: pricingKey(catalog.id, modelId),
          modelId,
          aliases: [],
          provider: price.provider,
          currency: 'USD',
          rates: {
            input: micros(price.input),
            output: micros(price.output),
            cachedInput: micros(price.cacheRead),
            cacheWrite: anthropic || price.cacheWrite === undefined ? null : micros(price.cacheWrite),
            cacheWrite5m: anthropic && price.cacheWrite5m !== undefined ? micros(price.cacheWrite5m) : null,
            cacheWrite1h: anthropic && price.cacheWrite1h !== undefined ? micros(price.cacheWrite1h) : null,
            // Every maker these catalogs price bills reasoning tokens as output; a price that differs says so.
            reasoning: micros(price.reasoning ?? price.output),
            image: null,
            tool: null,
          },
          source: { kind: 'model_catalog', catalog: catalog.id, sourceUrl: price.source },
          validFrom: MODEL_CATALOG_PRICE_VALID_FROM,
          validThrough: null,
          verifiedAt: `${price.verified}T00:00:00.000Z`,
          lastSyncedAt: null,
        });
        if (!parsed.success) continue;
        const identity = identityOf(modelId);
        const candidates = byIdentity.get(identity) ?? [];
        // One catalog listing a model in both halves is one price, read once.
        if (!candidates.some(candidate => candidate.catalog === catalog.id))
          candidates.push({ catalog: catalog.id, rate: parsed.data });
        byIdentity.set(identity, candidates);
      }
    }
  }
  const tierAliases = anthropicTierAliases(catalogs);
  return [...byIdentity.entries()]
    .filter(([identity]) => !tierAliases.has(identity))
    .map(([identity, candidates]) => {
      const maker = candidates.find(candidate => candidate.catalog === MAKER_CATALOGS[candidate.rate.provider]);
      const rate = (maker ?? (candidates[0] as Candidate)).rate;
      const aliases = [...tierAliases.entries()].filter(([, target]) => target === identity).map(([name]) => name);
      return maker !== undefined && aliases.length > 0 ? { ...rate, aliases } : rate;
    });
}
