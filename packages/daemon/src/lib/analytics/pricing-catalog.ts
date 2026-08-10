import { createHash } from 'node:crypto';
import {
  ANALYTICS_PRICING_RATE_SLOTS,
  type AnalyticsPricingCatalog,
  AnalyticsPricingCatalogSchema,
  type AnalyticsPricingFeed,
  type AnalyticsPricingFeedEntry,
  type AnalyticsPricingPatchOperation,
  type AnalyticsPricingRate,
  AnalyticsPricingRateSchema,
  type AnalyticsPricingSyncChange,
  type ConfiguredAnalyticsPricingSource,
  type ConfiguredAnalyticsPricingSources,
} from '@ferretry/protocol';
import { analyticsPricingCatalogFingerprint } from './store.ts';

/** A feed cannot be merged into a valid catalog, even though its wire document parsed. */
export class AnalyticsPricingCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsPricingCatalogError';
  }
}

/** A selected key was not one of the entries in the exact preview being applied. */
export class AnalyticsPricingSelectionError extends Error {
  constructor(readonly pricingKey: string) {
    super(`pricing key ${JSON.stringify(pricingKey)} is not an applicable add or update in this preview`);
    this.name = 'AnalyticsPricingSelectionError';
  }
}

/**
 * The optimistic identity of a catalog, shared with analytics ingestion.
 *
 * A catalog edit has one meaning everywhere in this daemon: it invalidates a stale Settings write
 * and it changes the evidence signature used for future ingest/reingest decisions. Reusing the
 * ingestion decision keeps those two consumers from developing different ideas of "the same
 * catalog".
 */
export const analyticsPricingFingerprint = analyticsPricingCatalogFingerprint;

/**
 * The optimistic identity of the configured feed list.
 *
 * Order is not part of a source's authority: moving an unchanged source up in a JSON array does not
 * let it fetch from somewhere else. Every field that DOES change that authority is included, and a
 * disabled source fingerprints differently from an enabled one.
 */
export function analyticsPricingSourcesFingerprint(sources: ConfiguredAnalyticsPricingSources): string {
  // `lastSyncedAt` is deliberately absent. It records a successful use of an unchanged authority;
  // it does not change which address this daemon may ask or what provider that answer is for.
  const entries = sources
    .map(source => JSON.stringify([source.id, source.provider, source.url, source.enabled]))
    .sort();
  return createHash('sha256')
    .update(JSON.stringify(['analytics-pricing-sources-v1', ...entries]))
    .digest('hex')
    .slice(0, 32);
}

/** Apply one person's structured intent without replacing rows they never addressed. */
export function applyAnalyticsPricingPatch(
  catalog: AnalyticsPricingCatalog,
  operations: readonly AnalyticsPricingPatchOperation[],
): AnalyticsPricingCatalog {
  const rates = new Map(catalog.map(rate => [rate.pricingKey, rate]));
  for (const operation of operations) {
    if (operation.op === 'remove') rates.delete(operation.pricingKey);
    else rates.set(operation.rate.pricingKey, operation.rate);
  }
  return AnalyticsPricingCatalogSchema.parse([...rates.values()]);
}

function sameAliases(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/**
 * Whether an existing synced row states the same feed-owned facts as one feed entry.
 *
 * `verifiedAt` and `lastSyncedAt` are intentionally absent. A fetch performed one minute later must
 * be able to report an unchanged price; otherwise the timestamp of checking would turn every row
 * into an update forever. An unchanged preview still carries `fetchedAt`, while applying an actual
 * add/update stamps both instants onto the new row.
 */
function feedEntryMatches(
  rate: AnalyticsPricingRate,
  entry: AnalyticsPricingFeedEntry,
  source: ConfiguredAnalyticsPricingSource,
): boolean {
  return (
    rate.pricingKey === entry.pricingKey &&
    rate.modelId === entry.modelId &&
    sameAliases(rate.aliases, entry.aliases) &&
    rate.provider === source.provider &&
    rate.currency === entry.currency &&
    ANALYTICS_PRICING_RATE_SLOTS.every(slot => rate.rates[slot] === entry.rates[slot]) &&
    rate.source.kind === 'provider_sync' &&
    rate.source.provider === source.provider &&
    rate.source.sourceUrl === source.url &&
    rate.validFrom === entry.validFrom &&
    rate.validThrough === entry.validThrough
  );
}

function syncedRate(
  entry: AnalyticsPricingFeedEntry,
  source: ConfiguredAnalyticsPricingSource,
  fetchedAt: string,
): AnalyticsPricingRate {
  return AnalyticsPricingRateSchema.parse({
    ...entry,
    provider: source.provider,
    source: { kind: 'provider_sync', provider: source.provider, sourceUrl: source.url },
    verifiedAt: fetchedAt,
    lastSyncedAt: fetchedAt,
  });
}

function replaceFromChanges(
  catalog: AnalyticsPricingCatalog,
  changes: readonly AnalyticsPricingSyncChange[],
): AnalyticsPricingCatalog {
  const rates = new Map(catalog.map(rate => [rate.pricingKey, rate]));
  for (const change of changes) {
    if (change.kind !== 'unchanged') rates.set(change.pricingKey, change.after);
  }
  try {
    return AnalyticsPricingCatalogSchema.parse([...rates.values()]);
  } catch (error) {
    throw new AnalyticsPricingCatalogError(
      `the fetched prices cannot form a valid catalog: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface AnalyticsPricingCatalogDiff {
  readonly changes: readonly AnalyticsPricingSyncChange[];
  /** The catalog produced if every add/update in the preview were selected. */
  readonly resultCatalog: AnalyticsPricingCatalog;
}

/**
 * Compare one bounded feed with the current catalog.
 *
 * A missing feed row is NEVER a removal. Absence says only what this fetch did not contain, while
 * deleting an effective price is a deliberate manual operation in the protocol contract.
 */
export function diffAnalyticsPricingCatalog(
  catalog: AnalyticsPricingCatalog,
  feed: AnalyticsPricingFeed,
  source: ConfiguredAnalyticsPricingSource,
  fetchedAt: string,
): AnalyticsPricingCatalogDiff {
  const current = new Map(catalog.map(rate => [rate.pricingKey, rate]));
  const seen = new Set<string>();
  const changes: AnalyticsPricingSyncChange[] = [];

  for (const entry of feed.entries) {
    if (seen.has(entry.pricingKey)) {
      throw new AnalyticsPricingCatalogError(
        `the fetched prices name pricing key ${JSON.stringify(entry.pricingKey)} more than once`,
      );
    }
    seen.add(entry.pricingKey);
    const before = current.get(entry.pricingKey);
    if (before === undefined) {
      changes.push({ kind: 'added', pricingKey: entry.pricingKey, after: syncedRate(entry, source, fetchedAt) });
    } else if (feedEntryMatches(before, entry, source)) {
      changes.push({ kind: 'unchanged', pricingKey: entry.pricingKey, before });
    } else {
      changes.push({
        kind: 'updated',
        pricingKey: entry.pricingKey,
        before,
        after: syncedRate(entry, source, fetchedAt),
      });
    }
  }

  return { changes, resultCatalog: replaceFromChanges(catalog, changes) };
}

/** Apply exactly the entries selected from one stored preview, and no others. */
export function applyAnalyticsPricingSelection(
  catalog: AnalyticsPricingCatalog,
  changes: readonly AnalyticsPricingSyncChange[],
  selectedPricingKeys: readonly string[],
): AnalyticsPricingCatalog {
  const offered = new Map(changes.map(change => [change.pricingKey, change]));
  const selected: AnalyticsPricingSyncChange[] = [];
  for (const pricingKey of selectedPricingKeys) {
    const change = offered.get(pricingKey);
    if (change === undefined || change.kind === 'unchanged') {
      throw new AnalyticsPricingSelectionError(pricingKey);
    }
    selected.push(change);
  }
  return replaceFromChanges(catalog, selected);
}
