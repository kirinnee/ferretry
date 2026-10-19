/**
 * The words every model picker shares (docs/model-catalog.md): a login's model catalog puts each
 * model in a TIER, and a picker lists the tiers in one order under one set of headings, so the
 * composer's chip, Info › Runtime, the new-session form, the Warden's model and a scan's model never
 * name the same tier two ways.
 *
 * Pure.
 */

export type ModelTier = 'best' | 'balanced' | 'fast';

/** Most capable first: the order a picker lists the tiers in. */
export const MODEL_TIERS: readonly ModelTier[] = ['best', 'balanced', 'fast'];

/** Each tier's heading. */
export const MODEL_TIER_LABELS: Readonly<Record<ModelTier, string>> = {
  best: 'Most capable',
  balanced: 'Balanced',
  fast: 'Fast',
};

/** A tier from an untrusted value, or `undefined`. */
export const asModelTier = (value: unknown): ModelTier | undefined =>
  typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value) ? (value as ModelTier) : undefined;

/** A context window in words a picker shows: `1M context`, `256K context`. */
export function contextWords(tokens: number | undefined): string | undefined {
  if (tokens === undefined || tokens <= 0) return undefined;
  if (tokens >= 1_000_000) {
    const millions = Math.round(tokens / 100_000) / 10;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : String(millions)}M context`;
  }
  return `${Math.round(tokens / 1000)}K context`;
}

/** One group a picker draws: a tier's heading and its models, in catalog order. */
export interface ModelTierGroup<T> {
  readonly tier: ModelTier | undefined;
  readonly heading: string | undefined;
  readonly items: readonly T[];
}

/**
 * The items grouped by tier, most capable first, each group in the order it came in. Items with no
 * tier (a model no catalog describes) are one headless group after the rest; a list in which NO item
 * has a tier is one headless group, so a picker without a catalog reads exactly as it did.
 */
export function groupByTier<T extends { readonly tier?: ModelTier | undefined }>(
  items: readonly T[],
): readonly ModelTierGroup<T>[] {
  if (!items.some(item => item.tier !== undefined))
    return items.length === 0 ? [] : [{ tier: undefined, heading: undefined, items }];
  const groups: ModelTierGroup<T>[] = MODEL_TIERS.flatMap(tier => {
    const inTier = items.filter(item => item.tier === tier);
    return inTier.length === 0 ? [] : [{ tier, heading: MODEL_TIER_LABELS[tier], items: inTier }];
  });
  const untiered = items.filter(item => item.tier === undefined);
  return untiered.length === 0 ? groups : [...groups, { tier: undefined, heading: 'Other', items: untiered }];
}

/**
 * A model id a person may type ("Custom id…"): one word a CLI takes after `--model`, the catalog's own
 * grammar, with an optional context suffix such as `[1m]`.
 */
export const CUSTOM_MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._:~/@+-]{0,159}(?:\[[a-z0-9]{1,8}\])?$/u;
