/**
 * The analytics prices the model catalogs give (docs/model-catalog.md § Prices): every catalog model
 * with a `price`, turned into the rate analytics charges a session at, with the provenance a person
 * needs to trust it — which catalog, the provider page it was read on, and the day.
 *
 * WHY THIS EXISTS. Analytics used to price a session from the operator's rates in `config/daemon.json`
 * alone, and those default to empty, so every session on every machine read "Unpriced". A catalog
 * already travels to every daemon, signed and versioned, on the catalog's own check schedule; carrying
 * a list price in it prices a fresh install without anybody typing a number, and a price change
 * reaches every machine the way a model change does — no second fetch, no timer.
 *
 * OPERATOR RATES WIN, PER MODEL. A model the operator priced — by its id or any alias — takes none of
 * these rates, over any window: an operator who stated a price stated the whole of it, and mixing their
 * windows with a catalog's would answer "what did this cost" from two authorities at once.
 *
 * ONE RATE PER MODEL. A model several catalogs list (Anthropic's ids are also the gateway's and
 * Vertex AI's) takes its MAKER's catalog's price — `anthropic` for an Anthropic-billed model, `openai`
 * for OpenAI's — and otherwise the first catalog by id, so the answer never depends on file order.
 *
 * SHORT TIER NAMES ARE ALIASES OF THE MAKER'S MODEL. Claude Code records `opus`, `sonnet` or `haiku` when
 * that is what a session was started with, and Anthropic's catalog pins each to a model (`tiers`). Those
 * names alias that model, so one model is one row and one price. Only the MAKER's catalog may do it: a
 * gateway re-pins the same slot names to its own models (Z.ai's `opus` is a GLM), and a catalog that
 * lists a model literally called `opus` (a Foundry deployment alias) is that tier name, not a second
 * model, so it adds no rate of its own.
 *
 * Pure.
 */
import { createHash } from 'node:crypto';
import { type ModelCatalog, SIGN_IN_MODEL_CATALOGS, slotModelId } from '@ferretry/fleet';
import {
  type AnalyticsPricingProvider,
  type AnalyticsPricingRate,
  AnalyticsPricingRateSchema,
  normalizeAnalyticsModelIdentity,
} from '@ferretry/protocol';

/**
 * A list price applies to every session, however old: it is the "equivalent API cost" of the tokens a
 * session used, not the record of a bill, so it has no beginning. The day it was read is `verifiedAt`.
 */
export const MODEL_CATALOG_PRICE_VALID_FROM = '1970-01-01T00:00:00.000Z';

/** The catalog each maker publishes its own prices in. The sign-in catalogs, then the makers' own. */
const MAKER_CATALOGS: Readonly<Record<AnalyticsPricingProvider, string>> = {
  anthropic: SIGN_IN_MODEL_CATALOGS.claude,
  openai: SIGN_IN_MODEL_CATALOGS.codex,
  deepseek: 'deepseek',
  moonshot: 'kimi',
  zai: 'zai',
  minimax: 'minimax',
  alibaba: 'qwen',
};

const HALVES = ['claude', 'codex'] as const;

const micros = (usd: number): number => Math.round(usd * 1_000_000);

/** A stable key under the protocol's bound, however long the model id. */
function pricingKey(catalog: string, modelId: string): string {
  const key = `model-catalog:${catalog}:${modelId}`;
  return key.length <= 128
    ? key
    : `model-catalog:${catalog}:${createHash('sha256').update(modelId).digest('hex').slice(0, 32)}`;
}

/** The comparable identity of a model id, as a transcript spelling of it would normalize. */
const identityOf = (spelling: string): string => normalizeAnalyticsModelIdentity(spelling)?.modelId ?? spelling;

interface Candidate {
  readonly catalog: string;
  readonly rate: AnalyticsPricingRate;
}

/** Every catalog model's price as an analytics rate, one per model identity (module doc). */
export function modelCatalogPricingRates(
  catalogs: Readonly<Record<string, ModelCatalog>>,
): readonly AnalyticsPricingRate[] {
  const byIdentity = new Map<string, Candidate[]>();
  for (const id of Object.keys(catalogs).sort()) {
    const catalog = catalogs[id] as ModelCatalog;
    for (const half of HALVES) {
      for (const model of catalog[half]?.models ?? []) {
        const price = model.price;
        if (price === undefined) continue;
        const anthropic = price.provider === 'anthropic';
        // The price passed the catalog schema; the rate schema is checked again so a rate this module
        // builds can never be one the analytics contract would refuse.
        const parsed = AnalyticsPricingRateSchema.safeParse({
          pricingKey: pricingKey(id, model.id),
          modelId: model.id,
          aliases: [],
          provider: price.provider,
          currency: 'USD',
          rates: {
            input: micros(price.input),
            output: micros(price.output),
            cachedInput: micros(price.cacheRead),
            cacheWrite: anthropic || price.cacheWrite === undefined ? null : micros(price.cacheWrite),
            cacheWrite5m: anthropic ? micros(price.cacheWrite5m as number) : null,
            cacheWrite1h: anthropic ? micros(price.cacheWrite1h as number) : null,
            // Every maker these catalogs price bills reasoning tokens as output; a price that differs says so.
            reasoning: micros(price.reasoning ?? price.output),
            image: null,
            tool: null,
          },
          source: { kind: 'model_catalog', catalog: id, sourceUrl: price.source },
          validFrom: MODEL_CATALOG_PRICE_VALID_FROM,
          validThrough: null,
          verifiedAt: `${price.verified}T00:00:00.000Z`,
          lastSyncedAt: null,
        });
        if (!parsed.success) continue;
        const identity = identityOf(model.id);
        const candidates = byIdentity.get(identity) ?? [];
        // One catalog listing a model in both halves is one price, read once.
        if (!candidates.some(candidate => candidate.catalog === id))
          candidates.push({ catalog: id, rate: parsed.data });
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

const TIER_NAMES = ['opus', 'sonnet', 'haiku'] as const;

/** Each tier name Anthropic's own catalog pins, mapped to the identity of the model it pins it to. */
function anthropicTierAliases(catalogs: Readonly<Record<string, ModelCatalog>>): ReadonlyMap<string, string> {
  const tiers = catalogs[MAKER_CATALOGS.anthropic]?.claude?.tiers;
  const aliases = new Map<string, string>();
  for (const name of TIER_NAMES) {
    const pinned = tiers?.[name];
    if (pinned !== undefined) aliases.set(name, identityOf(slotModelId(pinned)));
  }
  return aliases;
}

/**
 * The catalog rates a session can still be charged at once the operator's own rates are laid over
 * them: each one for a model no operator rate names by id or alias.
 */
export function unclaimedModelCatalogRates(
  operator: readonly AnalyticsPricingRate[],
  catalog: readonly AnalyticsPricingRate[],
): readonly AnalyticsPricingRate[] {
  const claimed = new Set(operator.flatMap(rate => [rate.modelId, ...rate.aliases].map(identityOf)));
  return catalog.filter(rate => !claimed.has(identityOf(rate.modelId)));
}

/** The whole catalog analytics prices a session from: the operator's rates, then the catalogs'. */
export function effectiveAnalyticsPricing(
  operator: readonly AnalyticsPricingRate[],
  catalogs: Readonly<Record<string, ModelCatalog>>,
): readonly AnalyticsPricingRate[] {
  return [...operator, ...unclaimedModelCatalogRates(operator, modelCatalogPricingRates(catalogs))];
}
