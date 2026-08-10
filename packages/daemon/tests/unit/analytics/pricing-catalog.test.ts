import { describe, expect, it } from 'bun:test';
import type {
  AnalyticsPricingCatalog,
  AnalyticsPricingFeed,
  AnalyticsPricingFeedEntry,
  AnalyticsPricingRate,
  ConfiguredAnalyticsPricingSource,
} from '@ferretry/protocol';
import {
  AnalyticsPricingCatalogError,
  AnalyticsPricingSelectionError,
  analyticsPricingSourcesFingerprint,
  applyAnalyticsPricingPatch,
  applyAnalyticsPricingSelection,
  diffAnalyticsPricingCatalog,
} from '../../../src/lib/analytics/pricing-catalog.ts';

const JANUARY = '2026-01-01T00:00:00.000Z';
const FEBRUARY = '2026-02-01T00:00:00.000Z';
const FEED_URL = 'https://pricing.example.test/openai.json';

const source = {
  id: 'openai-feed',
  provider: 'openai',
  url: FEED_URL,
  enabled: true,
  lastSyncedAt: null,
} as ConfiguredAnalyticsPricingSource;

const rates = {
  input: 2_000_000,
  output: 10_000_000,
  cachedInput: 200_000,
  cacheWrite: null,
  cacheWrite5m: null,
  cacheWrite1h: null,
  reasoning: 12_000_000,
  image: 250_000,
  tool: 50_000,
} as const;

function manualRate(pricingKey: string, modelId: string, aliases: readonly string[] = []): AnalyticsPricingRate {
  return {
    pricingKey,
    modelId,
    aliases,
    provider: 'openai',
    currency: 'USD',
    rates,
    source: { kind: 'manual' },
    validFrom: JANUARY,
    validThrough: null,
    verifiedAt: JANUARY,
    lastSyncedAt: null,
  };
}

function syncedRate(pricingKey: string, modelId: string, aliases: readonly string[] = []): AnalyticsPricingRate {
  return {
    ...manualRate(pricingKey, modelId, aliases),
    source: { kind: 'provider_sync', provider: 'openai', sourceUrl: FEED_URL },
    lastSyncedAt: JANUARY,
  };
}

function feedEntry(pricingKey: string, modelId: string, aliases: readonly string[] = []): AnalyticsPricingFeedEntry {
  return {
    pricingKey,
    modelId,
    aliases,
    currency: 'USD',
    rates,
    validFrom: JANUARY,
    validThrough: null,
  };
}

describe('analytics pricing fingerprints', () => {
  it('should ignore source order and change for every source authority field', () => {
    // Arrange
    const first = source;
    const second = {
      id: 'anthropic-feed',
      provider: 'anthropic',
      url: 'https://pricing.example.test/a.json',
      enabled: false,
      lastSyncedAt: null,
    } as const;
    const expected = analyticsPricingSourcesFingerprint([first, second]);

    // Act
    const reordered = analyticsPricingSourcesFingerprint([second, first]);
    const changed = [
      analyticsPricingSourcesFingerprint([{ ...first, id: 'other-feed' }, second]),
      analyticsPricingSourcesFingerprint([{ ...first, provider: 'anthropic' }, second]),
      analyticsPricingSourcesFingerprint([{ ...first, url: 'https://pricing.example.test/other.json' }, second]),
      analyticsPricingSourcesFingerprint([{ ...first, enabled: false }, second]),
    ];

    // Assert
    expect(reordered).toBe(expected);
    expect(changed.every(fingerprint => fingerprint !== expected)).toBe(true);
    expect(analyticsPricingSourcesFingerprint([{ ...first, lastSyncedAt: FEBRUARY }, second])).toBe(expected);
  });
});

describe('manual analytics pricing patches', () => {
  it('should upsert and remove only the pricing keys the operation names', () => {
    // Arrange
    const untouched = manualRate('keep', 'model-keep');
    const replaced = manualRate('replace', 'model-before');
    const removed = manualRate('remove', 'model-remove');
    const replacement = manualRate('replace', 'model-after');
    const added = manualRate('add', 'model-add');

    // Act
    const actual = applyAnalyticsPricingPatch(
      [untouched, replaced, removed],
      [
        { op: 'upsert', rate: replacement },
        { op: 'remove', pricingKey: removed.pricingKey },
        { op: 'upsert', rate: added },
      ],
    );

    // Assert
    expect(actual).toEqual([untouched, replacement, added]);
  });

  it('should refuse operations whose combined catalog violates a cross-row invariant', () => {
    // Arrange
    const catalog: AnalyticsPricingCatalog = [manualRate('first', 'model-a')];
    const conflicting = manualRate('second', 'model-a');

    // Act + Assert
    expect(() => applyAnalyticsPricingPatch(catalog, [{ op: 'upsert', rate: conflicting }])).toThrow();
  });
});

describe('provider pricing diff', () => {
  it('should return add, update and unchanged rows without treating feed absence as removal', () => {
    // Arrange
    const updatedBefore = manualRate('updated', 'model-updated');
    const unchangedBefore = syncedRate('unchanged', 'model-unchanged', ['alias-b', 'alias-a']);
    const omitted = manualRate('omitted', 'model-omitted');
    const input: AnalyticsPricingFeed = {
      entries: [
        feedEntry('updated', 'model-updated'),
        feedEntry('unchanged', 'model-unchanged', ['alias-a', 'alias-b']),
        feedEntry('added', 'model-added'),
      ],
    };

    // Act
    const actual = diffAnalyticsPricingCatalog([updatedBefore, unchangedBefore, omitted], input, source, FEBRUARY);

    // Assert
    expect(actual.changes.map(change => change.kind)).toEqual(['updated', 'unchanged', 'added']);
    expect(actual.changes.map(change => change.pricingKey)).toEqual(['updated', 'unchanged', 'added']);
    expect(actual.resultCatalog.map(rate => rate.pricingKey)).toEqual(['updated', 'unchanged', 'omitted', 'added']);
    const updated = actual.resultCatalog.find(rate => rate.pricingKey === 'updated');
    expect(updated?.source).toEqual({ kind: 'provider_sync', provider: 'openai', sourceUrl: FEED_URL });
    expect(updated?.verifiedAt).toBe(FEBRUARY);
    expect(updated?.lastSyncedAt).toBe(FEBRUARY);
    expect(actual.resultCatalog.find(rate => rate.pricingKey === 'unchanged')).toEqual(unchangedBefore);
    expect(actual.resultCatalog.find(rate => rate.pricingKey === 'omitted')).toEqual(omitted);
  });

  it('should refuse duplicate feed keys and a feed whose rows conflict with the current catalog', () => {
    // Arrange
    const duplicate: AnalyticsPricingFeed = {
      entries: [feedEntry('duplicate', 'model-a'), feedEntry('duplicate', 'model-b')],
    };
    const conflict: AnalyticsPricingFeed = { entries: [feedEntry('second-key', 'model-a')] };

    // Act + Assert
    expect(() => diffAnalyticsPricingCatalog([], duplicate, source, FEBRUARY)).toThrow(AnalyticsPricingCatalogError);
    expect(() => diffAnalyticsPricingCatalog([manualRate('first-key', 'model-a')], conflict, source, FEBRUARY)).toThrow(
      AnalyticsPricingCatalogError,
    );
  });
});

describe('pricing preview selection', () => {
  it('should apply exactly the selected add or update and leave every other preview row alone', () => {
    // Arrange
    const before = manualRate('updated', 'model-updated');
    const input: AnalyticsPricingFeed = {
      entries: [feedEntry('updated', 'model-updated'), feedEntry('added', 'model-added')],
    };
    const preview = diffAnalyticsPricingCatalog([before], input, source, FEBRUARY);

    // Act
    const actual = applyAnalyticsPricingSelection([before], preview.changes, ['added']);

    // Assert
    expect(actual.find(rate => rate.pricingKey === 'updated')).toEqual(before);
    expect(actual.map(rate => rate.pricingKey)).toEqual(['updated', 'added']);
  });

  it('should reject a key that the exact preview never offered', () => {
    // Arrange
    const preview = diffAnalyticsPricingCatalog([], { entries: [feedEntry('offered', 'model-a')] }, source, FEBRUARY);

    // Act + Assert
    expect(() => applyAnalyticsPricingSelection([], preview.changes, ['not-offered'])).toThrow(
      AnalyticsPricingSelectionError,
    );
  });

  it('should reject an unchanged row rather than accept a selected no-op', () => {
    // Arrange
    const before = syncedRate('unchanged', 'model-a');
    const preview = diffAnalyticsPricingCatalog(
      [before],
      { entries: [feedEntry('unchanged', 'model-a')] },
      source,
      FEBRUARY,
    );

    // Act + Assert
    expect(() => applyAnalyticsPricingSelection([before], preview.changes, ['unchanged'])).toThrow(
      AnalyticsPricingSelectionError,
    );
  });
});
