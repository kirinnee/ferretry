import { type AnalyticsPricingRate, normalizeAnalyticsModelIdentity } from '../../../contract/index.ts';

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
