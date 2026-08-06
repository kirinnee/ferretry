import { describe, it } from 'bun:test';
import should from 'should';
import * as pricingApi from '../../src/lib/analytics-pricing-api.ts';
import {
  AnalyticsPricingFingerprintSchema,
  AnalyticsPricingPatchOperationSchema,
  AnalyticsPricingPatchSchema,
  AnalyticsPricingPreviewIdSchema,
  AnalyticsPricingRateSchema,
  AnalyticsPricingSyncApplySchema,
  AnalyticsPricingSyncChangeSchema,
  AnalyticsPricingSyncPreviewRequestSchema,
  AnalyticsPricingSyncPreviewSchema,
  AnalyticsPricingViewSchema,
  ManualAnalyticsPricingRateSchema,
  type AnalyticsPricingRates,
} from '../../src/lib/index.ts';
import { INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const FEED_URL = 'https://prices.example.test/openai.json';
const BASE = 'catalog-fingerprint-before';
const RESULT = 'catalog-fingerprint-after';

const rates: AnalyticsPricingRates = {
  input: 2_000_000,
  output: 10_000_000,
  cachedInput: 200_000,
  cacheWrite: null,
  cacheWrite5m: null,
  cacheWrite1h: null,
  reasoning: null,
  image: null,
  tool: null,
};

const rate = {
  pricingKey: 'operator:model-a:2026-07',
  modelId: 'model-a',
  aliases: [],
  provider: 'openai',
  currency: 'USD',
  rates,
  source: { kind: 'manual' },
  validFrom: INSTANT,
  validThrough: null,
  verifiedAt: INSTANT,
  lastSyncedAt: null,
} as const;

const dearer = { ...rate, rates: { ...rates, output: 12_000_000 } } as const;

/** The same price as a daemon would have recorded it after a sync — never as a client may submit it. */
const syncedRate = {
  ...rate,
  source: { kind: 'provider_sync', provider: 'openai', sourceUrl: FEED_URL },
  lastSyncedAt: INSTANT,
} as const;

const view = {
  catalog: [rate],
  catalogFingerprint: BASE,
  sources: [{ id: 'openai-public', provider: 'openai', url: FEED_URL, enabled: true }],
  sourcesFingerprint: 'sources-fingerprint',
} as const;

const patch = {
  expectedCatalogFingerprint: BASE,
  operations: [
    { op: 'upsert', rate },
    { op: 'remove', pricingKey: 'operator:model-z:2026-01' },
  ],
} as const;

const preview = {
  previewId: 'preview-1',
  sourceId: 'openai-public',
  provider: 'openai',
  sourceUrl: FEED_URL,
  fetchedAt: INSTANT,
  baseCatalogFingerprint: BASE,
  resultCatalogFingerprint: RESULT,
  changes: [
    { kind: 'added', pricingKey: 'operator:model-b:2026-08', after: { ...rate, modelId: 'model-b' } },
    { kind: 'updated', pricingKey: rate.pricingKey, before: rate, after: dearer },
    { kind: 'unchanged', pricingKey: rate.pricingKey, before: rate },
  ],
} as const;

const apply = {
  previewId: 'preview-1',
  expectedCatalogFingerprint: BASE,
  expectedResultFingerprint: RESULT,
  selectedPricingKeys: [rate.pricingKey],
} as const;

const cases: readonly SchemaCase[] = [
  { name: 'fingerprint', schema: AnalyticsPricingFingerprintSchema, value: BASE },
  { name: 'preview id', schema: AnalyticsPricingPreviewIdSchema, value: 'preview-1' },
  { name: 'view', schema: AnalyticsPricingViewSchema, value: view },
  { name: 'manual rate', schema: ManualAnalyticsPricingRateSchema, value: rate },
  { name: 'patch operation', schema: AnalyticsPricingPatchOperationSchema, value: { op: 'upsert', rate } },
  { name: 'patch', schema: AnalyticsPricingPatchSchema, value: patch },
  {
    name: 'preview request',
    schema: AnalyticsPricingSyncPreviewRequestSchema,
    value: { sourceId: 'openai-public', expectedCatalogFingerprint: BASE },
  },
  {
    name: 'sync change',
    schema: AnalyticsPricingSyncChangeSchema,
    value: { kind: 'updated', pricingKey: rate.pricingKey, before: rate, after: dearer },
  },
  { name: 'preview', schema: AnalyticsPricingSyncPreviewSchema, value: preview },
  { name: 'apply', schema: AnalyticsPricingSyncApplySchema, value: apply },
];

describe('analytics pricing API contract', () => {
  it('should round-trip every pricing DTO and cover all of them', () => {
    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(pricingApi, cases);
  });

  it('should make a manual edit say what it meant rather than replacing the table', () => {
    // Act
    const actual = AnalyticsPricingPatchSchema.parse(patch);

    // Assert
    should(actual.operations[0]?.op).equal('upsert');
    should(actual.operations[1]).deepEqual({ op: 'remove', pricingKey: 'operator:model-z:2026-01' });
  });

  it('should refuse a submitted rate that awards itself provider provenance', () => {
    // A patch is the typed path. Accepting `provider_sync` here would let a caller claim its numbers
    // came from a feed — and name an arbitrary allowed https `sourceUrl` while doing it — which is
    // the one claim only the daemon that performed the fetch is in a position to make.
    // Act
    const submitted = ManualAnalyticsPricingRateSchema.safeParse(syncedRate);
    const patched = AnalyticsPricingPatchSchema.safeParse({
      expectedCatalogFingerprint: BASE,
      operations: [{ op: 'upsert', rate: syncedRate }],
    });

    // Assert: named by path, so this proves the new rule fired rather than some other refusal.
    should(submitted.success).be.false();
    should(submitted.error?.issues.map(issue => issue.path)).containDeep([['source', 'kind']]);
    should(patched.success).be.false();
    // The same rate with the provenance a person actually has is accepted unchanged.
    should(ManualAnalyticsPricingRateSchema.parse(rate)).deepEqual(rate);
    should(AnalyticsPricingRateSchema.parse(syncedRate).source.kind).equal('provider_sync');
  });

  it('should refuse a patch that edits one price twice or edits nothing', () => {
    // Two operations for one key have no defined order, so the surviving value would depend on the
    // array rather than on what the person asked for.
    // Act + Assert
    assertRejects([
      {
        name: 'same key twice',
        schema: AnalyticsPricingPatchSchema,
        value: {
          ...patch,
          operations: [
            { op: 'upsert', rate },
            { op: 'remove', pricingKey: rate.pricingKey },
          ],
        },
      },
      { name: 'no operations', schema: AnalyticsPricingPatchSchema, value: { ...patch, operations: [] } },
      {
        name: 'unknown operation',
        schema: AnalyticsPricingPatchSchema,
        value: { ...patch, operations: [{ op: 'replace', rate }] },
      },
    ]);
  });

  it('should refuse a preview request that supplies an address instead of naming a configured feed', () => {
    // Act + Assert
    assertRejects([
      {
        name: 'submitted url',
        schema: AnalyticsPricingSyncPreviewRequestSchema,
        value: { sourceId: 'openai-public', expectedCatalogFingerprint: BASE, url: FEED_URL },
      },
      {
        name: 'no catalog identity',
        schema: AnalyticsPricingSyncPreviewRequestSchema,
        value: { sourceId: 'openai-public' },
      },
    ]);
  });

  it('should refuse a change describing two different prices as one update', () => {
    // Act
    const actual = AnalyticsPricingSyncChangeSchema.safeParse({
      kind: 'updated',
      pricingKey: rate.pricingKey,
      before: rate,
      after: { ...dearer, pricingKey: 'operator:model-other:2026-07' },
    });

    // Assert
    should(actual.success).be.false();
  });

  it('should apply only the rows a person reviewed, out of the preview they were shown', () => {
    // Act
    const actual = AnalyticsPricingSyncApplySchema.parse(apply);
    const noSelection = AnalyticsPricingSyncApplySchema.safeParse({ ...apply, selectedPricingKeys: [] });
    const repeated = AnalyticsPricingSyncApplySchema.safeParse({
      ...apply,
      selectedPricingKeys: [rate.pricingKey, rate.pricingKey],
    });
    const noResultIdentity = AnalyticsPricingSyncApplySchema.safeParse({
      previewId: apply.previewId,
      expectedCatalogFingerprint: BASE,
      selectedPricingKeys: [rate.pricingKey],
    });

    // Assert
    should(actual.selectedPricingKeys).deepEqual([rate.pricingKey]);
    // An empty list is a payload that lost its selection, not an instruction to apply everything.
    should(noSelection.success).be.false();
    should(repeated.success).be.false();
    should(noResultIdentity.success).be.false();
  });
});
