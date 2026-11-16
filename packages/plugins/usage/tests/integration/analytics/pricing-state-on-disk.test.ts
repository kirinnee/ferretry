/**
 * The owner's pricing configuration over the kernel's REAL state port and a temp folder: a missing file is an empty
 * catalog, a damaged one is unavailable (never free), and a write is kept only against the fingerprints the owner saw.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state } from '@ferretry/kernel/host';
import { instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import { type ConfiguredAnalyticsPricingSource, PRICING_STATE } from '../../../contract/index.ts';
import { StatePricingConfiguration } from '../../../daemon/adapters/pricing/pricing-state.ts';
import {
  analyticsPricingFingerprint,
  analyticsPricingSourcesFingerprint,
} from '../../../daemon/lib/analytics/pricing-catalog.ts';
import manifest from '../../../manifest.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function disk() {
  const home = await mkdtemp(join(tmpdir(), 'fy-usage-pricing-'));
  homes.push(home);
  const port = state.createStatePort({
    home,
    pluginId: 'usage',
    files: manifest.data.state,
    fs: state.createNodeHostFs(),
  });
  return { adapter: new StatePricingConfiguration(port), file: join(home, 'state', 'usage', PRICING_STATE.path) };
}

const feed: ConfiguredAnalyticsPricingSource = {
  id: 'openai-feed',
  provider: 'openai',
  url: 'https://prices.example.test/openai.json',
  enabled: true,
  lastSyncedAt: null,
};
const EMPTY_CATALOG = analyticsPricingFingerprint([]);
const EMPTY_SOURCES = analyticsPricingSourcesFingerprint([]);

describe('the pricing configuration on disk', () => {
  it('should read a fresh install as an empty catalog with no sources', async () => {
    const { adapter } = await disk();

    should(await adapter.readPricing()).deepEqual({ kind: 'read', configuration: { catalog: [], sources: [] } });
  });

  it('should keep a write made against the current fingerprint, and read it back after a restart', async () => {
    const { adapter } = await disk();

    const written = await adapter.writePricing({
      catalog: [],
      expectedCatalogFingerprint: EMPTY_CATALOG,
      touchedPricingKeys: [],
    });
    const again = await adapter.readPricing();

    should(written).deepEqual({ kind: 'written', configuration: { catalog: [], sources: [] } });
    should(again).deepEqual({ kind: 'read', configuration: { catalog: [], sources: [] } });
  });

  it('should refuse a write made against a catalog or source list that has since changed, and change nothing', async () => {
    const { adapter, file } = await disk();
    await adapter.writePricing({ catalog: [], expectedCatalogFingerprint: EMPTY_CATALOG, touchedPricingKeys: [] });
    await writeFile(file, JSON.stringify({ format: 1, catalog: [], sources: [feed] }));

    const staleSources = await adapter.writePricing({
      catalog: [],
      expectedCatalogFingerprint: EMPTY_CATALOG,
      expectedSourcesFingerprint: EMPTY_SOURCES,
      touchedPricingKeys: [],
    });
    const staleCatalog = await adapter.writePricing({
      catalog: [],
      expectedCatalogFingerprint: 'not-the-catalog-the-owner-saw',
      touchedPricingKeys: [],
    });

    should(staleSources.kind).equal('stale_sources');
    should(staleCatalog.kind).equal('stale_catalog');
    should(await adapter.readPricing()).deepEqual({ kind: 'read', configuration: { catalog: [], sources: [feed] } });
  });

  it('should stamp the source that was just synced and leave the others as they were', async () => {
    const { adapter, file } = await disk();
    const other = { ...feed, id: 'anthropic-feed', provider: 'anthropic' as const };
    await adapter.writePricing({ catalog: [], expectedCatalogFingerprint: EMPTY_CATALOG, touchedPricingKeys: [] });
    await writeFile(file, JSON.stringify({ format: 1, catalog: [], sources: [feed, other] }));
    const lastSyncedAt = instantFromEpochMs(Date.parse('2026-10-18T08:00:00Z'));

    const written = await adapter.writePricing({
      catalog: [],
      expectedCatalogFingerprint: EMPTY_CATALOG,
      expectedSourcesFingerprint: analyticsPricingSourcesFingerprint([feed, other]),
      syncedSource: { sourceId: 'openai-feed', lastSyncedAt },
      touchedPricingKeys: [],
    });

    should(written.kind).equal('written');
    should(await adapter.readPricing()).deepEqual({
      kind: 'read',
      configuration: { catalog: [], sources: [{ ...feed, lastSyncedAt }, other] },
    });
  });

  it('should call a damaged file unavailable, never an empty catalog that would price a fleet as free', async () => {
    const { adapter, file } = await disk();
    await adapter.writePricing({ catalog: [], expectedCatalogFingerprint: EMPTY_CATALOG, touchedPricingKeys: [] });
    await writeFile(file, '{ not json');

    const read = await adapter.readPricing();
    const write = await adapter.writePricing({
      catalog: [],
      expectedCatalogFingerprint: EMPTY_CATALOG,
      touchedPricingKeys: [],
    });

    should(read.kind).equal('unavailable');
    should(write.kind).equal('unavailable');
  });
});
