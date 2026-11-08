import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import type { ConfiguredAnalyticsPricingSource, PricingFile } from '../../../contract/index.ts';
import { StatePricingConfiguration } from '../../../daemon/adapters/pricing/pricing-state.ts';
import {
  analyticsPricingFingerprint,
  analyticsPricingSourcesFingerprint,
} from '../../../daemon/lib/analytics/pricing-catalog.ts';

const source = {
  id: 'openai-feed',
  provider: 'openai',
  url: 'https://prices.example.test/openai.json',
  enabled: true,
  lastSyncedAt: null,
} as ConfiguredAnalyticsPricingSource;

const EMPTY_CATALOG_FINGERPRINT = analyticsPricingFingerprint([]);

type Mode = 'ok' | 'damaged' | 'silent';

/** A state port holding one pricing file: `damaged` refuses every read and update, `silent` never runs the transform. */
function pricingState(initial: PricingFile | undefined, mode: Mode = 'ok') {
  const held: { file: PricingFile | undefined } = { file: initial };
  const damage = { ok: false, error: { sentence: 'the pricing file cannot be read' } };
  const port = {
    read: async () => (mode === 'damaged' ? damage : { ok: true, value: held.file }),
    update: async (_file: unknown, fn: (current: PricingFile | undefined) => PricingFile) => {
      if (mode === 'damaged') return damage;
      if (mode === 'silent') return { ok: true, value: held.file };
      const next = fn(held.file);
      if (next !== held.file) held.file = next;
      return { ok: true, value: next };
    },
  } as unknown as StatePort;
  return { adapter: new StatePricingConfiguration(port), held };
}

describe('the pricing configuration kept in the usage state', () => {
  test('a missing file reads as an empty catalog and no sources, a damaged one as unavailable', async () => {
    expect(await pricingState(undefined).adapter.readPricing()).toEqual({
      kind: 'read',
      configuration: { catalog: [], sources: [] },
    });
    expect(await pricingState(undefined, 'damaged').adapter.readPricing()).toEqual({
      kind: 'unavailable',
      message: 'the pricing file cannot be read',
    });
  });

  test('a write whose catalog fingerprint is current is kept and the sources stay as they were', async () => {
    const { adapter, held } = pricingState({ catalog: [], sources: [source] });
    const written = await adapter.writePricing({
      catalog: [],
      expectedCatalogFingerprint: EMPTY_CATALOG_FINGERPRINT,
      touchedPricingKeys: [],
    });
    expect(written).toEqual({ kind: 'written', configuration: { catalog: [], sources: [source] } });
    expect(held.file).toEqual({ catalog: [], sources: [source] });
  });

  test('a write on a file that does not exist yet starts from an empty one', async () => {
    const { adapter, held } = pricingState(undefined);
    const written = await adapter.writePricing({
      catalog: [],
      expectedCatalogFingerprint: EMPTY_CATALOG_FINGERPRINT,
      touchedPricingKeys: [],
    });
    expect(written.kind).toBe('written');
    expect(held.file).toEqual({ catalog: [], sources: [] });
  });

  test('a write made against a catalog that has since changed is stale and leaves the file alone', async () => {
    const { adapter, held } = pricingState({ catalog: [], sources: [source] });
    const written = await adapter.writePricing({
      catalog: [],
      expectedCatalogFingerprint: 'a-catalog-nobody-holds',
      touchedPricingKeys: [],
    });
    expect(written).toEqual({ kind: 'stale_catalog', configuration: { catalog: [], sources: [source] } });
    expect(held.file).toEqual({ catalog: [], sources: [source] });
  });

  test('a sync apply reviewed against other sources is stale, and one against the current sources is applied', async () => {
    const { adapter, held } = pricingState({ catalog: [], sources: [source] });
    const stale = await adapter.writePricing({
      catalog: [],
      expectedCatalogFingerprint: EMPTY_CATALOG_FINGERPRINT,
      expectedSourcesFingerprint: analyticsPricingSourcesFingerprint([
        { ...source, url: 'https://other.example.test/feed' },
      ]),
      touchedPricingKeys: [],
    });
    expect(stale).toEqual({ kind: 'stale_sources', configuration: { catalog: [], sources: [source] } });

    const synced = await adapter.writePricing({
      catalog: [],
      expectedCatalogFingerprint: EMPTY_CATALOG_FINGERPRINT,
      expectedSourcesFingerprint: analyticsPricingSourcesFingerprint([source]),
      touchedPricingKeys: [],
      syncedSource: { sourceId: 'openai-feed', lastSyncedAt: '2026-11-01T00:00:00.000Z' },
    });
    expect(synced.kind).toBe('written');
    expect(held.file?.sources).toEqual([{ ...source, lastSyncedAt: '2026-11-01T00:00:00.000Z' }]);
  });

  test('a synced source that names no configured source changes none of them', async () => {
    const { adapter, held } = pricingState({ catalog: [], sources: [source] });
    await adapter.writePricing({
      catalog: [],
      expectedCatalogFingerprint: EMPTY_CATALOG_FINGERPRINT,
      touchedPricingKeys: [],
      syncedSource: { sourceId: 'no-such-feed', lastSyncedAt: '2026-11-01T00:00:00.000Z' },
    });
    expect(held.file?.sources).toEqual([source]);
  });

  test('a write to a damaged file, or one the file never answered, is unavailable and never written', async () => {
    const input = { catalog: [], expectedCatalogFingerprint: EMPTY_CATALOG_FINGERPRINT, touchedPricingKeys: [] };
    expect(await pricingState(undefined, 'damaged').adapter.writePricing(input)).toEqual({
      kind: 'unavailable',
      message: 'the pricing file cannot be read',
    });
    expect(await pricingState(undefined, 'silent').adapter.writePricing(input)).toEqual({
      kind: 'unavailable',
      message: 'the pricing file did not answer',
    });
  });
});
