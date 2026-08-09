import { describe, expect, it } from 'bun:test';
import {
  ANALYTICS_PRICING_RATE_APPLICABILITY,
  type AnalyticsPricingCatalog,
  type AnalyticsPricingFeed,
  type AnalyticsPricingFeedEntry,
  type AnalyticsPricingRate,
  type AnalyticsPricingSyncApply,
  type ConfiguredAnalyticsPricingSource,
} from '@ferretry/protocol';
import {
  analyticsPricingFingerprint,
  analyticsPricingSourcesFingerprint,
} from '../../../src/lib/analytics/pricing-catalog.ts';
import {
  type AnalyticsPricingConfiguration,
  type AnalyticsPricingConfigurationPort,
  type AnalyticsPricingConfigurationRead,
  type AnalyticsPricingConfigurationWrite,
  type AnalyticsPricingConfigurationWriteResult,
  type AnalyticsPricingFeedPort,
  type AnalyticsPricingFeedRead,
  AnalyticsPricingService,
} from '../../../src/lib/analytics/pricing-service.ts';
import type { SerialExecutor } from '../../../src/lib/ports.ts';

const JANUARY = '2026-01-01T00:00:00.000Z';
const FEBRUARY = '2026-02-01T00:00:00.000Z';
const FEED_URL = 'https://pricing.example.test/openai.json';

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

const source = {
  id: 'openai-feed',
  provider: 'openai',
  url: FEED_URL,
  enabled: true,
  lastSyncedAt: null,
} as ConfiguredAnalyticsPricingSource;

function manualRate(pricingKey: string, modelId = pricingKey, aliases: readonly string[] = []): AnalyticsPricingRate {
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

function syncedRate(pricingKey: string, modelId = pricingKey, aliases: readonly string[] = []): AnalyticsPricingRate {
  return {
    ...manualRate(pricingKey, modelId, aliases),
    source: { kind: 'provider_sync', provider: 'openai', sourceUrl: FEED_URL },
    lastSyncedAt: JANUARY,
  };
}

function feedEntry(
  pricingKey: string,
  modelId = pricingKey,
  aliases: readonly string[] = [],
): AnalyticsPricingFeedEntry {
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

const immediateSerial: SerialExecutor = {
  run: async (_key, work) => await work(),
  runExclusive: async work => await work(),
};

class MemoryPricingDocument implements AnalyticsPricingConfigurationPort {
  readonly writes: AnalyticsPricingConfigurationWrite[] = [];
  readResult?: AnalyticsPricingConfigurationRead;
  writeResult?: AnalyticsPricingConfigurationWriteResult;

  constructor(public configuration: AnalyticsPricingConfiguration) {}

  async readPricing(): Promise<AnalyticsPricingConfigurationRead> {
    return this.readResult ?? { kind: 'read', configuration: this.configuration };
  }

  async writePricing(input: AnalyticsPricingConfigurationWrite): Promise<AnalyticsPricingConfigurationWriteResult> {
    this.writes.push(input);
    if (this.writeResult !== undefined) return this.writeResult;
    const sources =
      input.syncedSource === undefined
        ? this.configuration.sources
        : this.configuration.sources.map(candidate =>
            candidate.id === input.syncedSource?.sourceId
              ? { ...candidate, lastSyncedAt: input.syncedSource.lastSyncedAt }
              : candidate,
          );
    this.configuration = { catalog: input.catalog, sources };
    return { kind: 'written', configuration: this.configuration };
  }
}

interface Harness {
  readonly service: AnalyticsPricingService;
  readonly document: MemoryPricingDocument;
  readonly setFeed: (
    next:
      | AnalyticsPricingFeedRead
      | ((selected: ConfiguredAnalyticsPricingSource) => AnalyticsPricingFeedRead | Promise<AnalyticsPricingFeedRead>),
  ) => void;
  readonly setNow: (next: string) => void;
}

function harness(
  catalog: AnalyticsPricingCatalog = [],
  sources: readonly ConfiguredAnalyticsPricingSource[] = [source],
  options: { readonly previewLimit?: number; readonly previewTtlMs?: number } = {},
): Harness {
  const document = new MemoryPricingDocument({ catalog, sources });
  let feed:
    | AnalyticsPricingFeedRead
    | ((selected: ConfiguredAnalyticsPricingSource) => AnalyticsPricingFeedRead | Promise<AnalyticsPricingFeedRead>) = {
    kind: 'feed',
    feed: { entries: [] },
  };
  const feedPort: AnalyticsPricingFeedPort = {
    read: async selected => (typeof feed === 'function' ? await feed(selected) : feed),
  };
  let now = FEBRUARY;
  let nextId = 0;
  return {
    document,
    service: new AnalyticsPricingService(
      document,
      feedPort,
      immediateSerial,
      { now: () => now },
      { next: () => `preview-${String(++nextId)}` },
      options,
    ),
    setFeed: next => {
      feed = next;
    },
    setNow: next => {
      now = next;
    },
  };
}

async function previewWith(
  subject: Harness,
  feed: AnalyticsPricingFeed,
): Promise<Awaited<ReturnType<AnalyticsPricingService['preview']>>> {
  subject.setFeed({ kind: 'feed', feed });
  return await subject.service.preview({
    sourceId: source.id,
    expectedCatalogFingerprint: analyticsPricingFingerprint(subject.document.configuration.catalog),
  });
}

function applyRequest(
  preview: Awaited<ReturnType<AnalyticsPricingService['preview']>>,
  selectedPricingKeys: readonly string[],
): AnalyticsPricingSyncApply {
  return {
    previewId: preview.previewId,
    expectedCatalogFingerprint: preview.baseCatalogFingerprint,
    expectedResultFingerprint: preview.resultCatalogFingerprint,
    selectedPricingKeys,
  };
}

describe('AnalyticsPricingService view and manual patch', () => {
  it('should return the current catalog, configured-source metadata, identities, and total applicability', async () => {
    // Arrange
    const catalog = [manualRate('manual')];
    const subject = harness(catalog);

    // Act
    const actual = await subject.service.view();

    // Assert
    expect(actual).toEqual({
      catalog,
      catalogFingerprint: analyticsPricingFingerprint(catalog),
      sources: [source],
      sourcesFingerprint: analyticsPricingSourcesFingerprint([source]),
      rateApplicability: ANALYTICS_PRICING_RATE_APPLICABILITY,
    });
  });

  it('should apply only structured manual operations and report their exact touched keys', async () => {
    // Arrange
    const keep = manualRate('keep');
    const remove = manualRate('remove');
    const subject = harness([keep, remove]);
    const added = manualRate('add');

    // Act
    const actual = await subject.service.patch({
      expectedCatalogFingerprint: analyticsPricingFingerprint([keep, remove]),
      operations: [
        { op: 'remove', pricingKey: remove.pricingKey },
        { op: 'upsert', rate: added },
      ],
    });

    // Assert
    expect(actual.catalog).toEqual([keep, added]);
    expect(subject.document.writes[0]?.touchedPricingKeys).toEqual(['remove', 'add']);
    expect(subject.document.writes[0]?.expectedSourcesFingerprint).toBeUndefined();
  });

  it.each([
    {
      name: 'stale edit fingerprint',
      patch: { expectedCatalogFingerprint: 'stale', operations: [{ op: 'upsert', rate: manualRate('new') }] },
      failure: 'stale_catalog',
    },
    {
      name: 'unknown removal',
      patch: {
        expectedCatalogFingerprint: analyticsPricingFingerprint([]),
        operations: [{ op: 'remove', pricingKey: 'missing' }],
      },
      failure: 'invalid_selection',
    },
  ])('should refuse a $name without writing', async ({ patch, failure }) => {
    // Arrange
    const subject = harness();

    // Act + Assert
    await expect(subject.service.patch(patch as never)).rejects.toMatchObject({ failure });
    expect(subject.document.writes).toHaveLength(0);
  });

  it('should refuse a patch whose merged rows form an ambiguous catalog', async () => {
    // Arrange
    const existing = manualRate('first', 'same-model');
    const subject = harness([existing]);

    // Act + Assert
    await expect(
      subject.service.patch({
        expectedCatalogFingerprint: analyticsPricingFingerprint([existing]),
        operations: [{ op: 'upsert', rate: manualRate('second', 'same-model') }],
      }),
    ).rejects.toMatchObject({ failure: 'invalid_catalog' });
  });

  it.each([
    { kind: 'stale_catalog', failure: 'stale_catalog' },
    { kind: 'unavailable', failure: 'configuration_unavailable' },
  ] as const)('should translate a $kind write result without pretending it succeeded', async ({ kind, failure }) => {
    // Arrange
    const subject = harness();
    subject.document.writeResult =
      kind === 'stale_catalog'
        ? { kind, configuration: subject.document.configuration }
        : { kind, message: 'not readable' };

    // Act + Assert
    await expect(
      subject.service.patch({
        expectedCatalogFingerprint: analyticsPricingFingerprint([]),
        operations: [{ op: 'upsert', rate: manualRate('new') }],
      }),
    ).rejects.toMatchObject({ failure });
  });

  it('should report an unreadable configuration as unavailable', async () => {
    // Arrange
    const subject = harness();
    subject.document.readResult = { kind: 'unavailable', message: 'damaged document' };

    // Act + Assert
    await expect(subject.service.view()).rejects.toMatchObject({ failure: 'configuration_unavailable' });
  });
});

describe('AnalyticsPricingService preview', () => {
  it('should diff a configured source without writing or pre-applying any row', async () => {
    // Arrange
    const update = manualRate('update');
    const unchanged = syncedRate('unchanged');
    const subject = harness([update, unchanged]);
    const input = {
      entries: [feedEntry('update'), feedEntry('unchanged'), feedEntry('add')],
    };

    // Act
    const actual = await previewWith(subject, input);

    // Assert
    expect(actual.changes.map(change => change.kind)).toEqual(['updated', 'unchanged', 'added']);
    expect(actual.fetchedAt).toBe(FEBRUARY);
    expect(actual.sourceId).toBe(source.id);
    expect(subject.document.configuration.catalog).toEqual([update, unchanged]);
    expect(subject.document.writes).toHaveLength(0);
  });

  it.each([
    { read: { kind: 'unreachable' }, failure: 'source_unreachable' },
    { read: { kind: 'timeout' }, failure: 'source_timeout' },
    { read: { kind: 'status', status: 502 }, failure: 'source_status' },
    { read: { kind: 'oversized' }, failure: 'source_oversized' },
    { read: { kind: 'invalid_json' }, failure: 'source_invalid_json' },
    { read: { kind: 'invalid_schema' }, failure: 'source_invalid_schema' },
  ] as const)('should translate $failure without storing a preview', async ({ read, failure }) => {
    // Arrange
    const subject = harness();
    subject.setFeed(read);

    // Act + Assert
    await expect(
      subject.service.preview({
        sourceId: source.id,
        expectedCatalogFingerprint: analyticsPricingFingerprint([]),
      }),
    ).rejects.toMatchObject({
      failure,
      ...(read.kind === 'status' ? { sourceStatus: 502 } : {}),
    });
  });

  it.each([
    { name: 'unknown source', sources: [] as const, sourceId: 'missing', failure: 'unknown_source' },
    {
      name: 'disabled source',
      sources: [{ ...source, enabled: false }] as const,
      sourceId: source.id,
      failure: 'disabled_source',
    },
  ])('should refuse a $name before fetching', async ({ sources, sourceId, failure }) => {
    // Arrange
    const subject = harness([], sources);
    let fetched = false;
    subject.setFeed(() => {
      fetched = true;
      return { kind: 'feed', feed: { entries: [] } };
    });

    // Act + Assert
    await expect(
      subject.service.preview({ sourceId, expectedCatalogFingerprint: analyticsPricingFingerprint([]) }),
    ).rejects.toMatchObject({ failure });
    expect(fetched).toBe(false);
  });

  it('should refuse a stale request fingerprint before fetching', async () => {
    // Arrange
    const subject = harness();
    let fetched = false;
    subject.setFeed(() => {
      fetched = true;
      return { kind: 'feed', feed: { entries: [] } };
    });

    // Act + Assert
    await expect(
      subject.service.preview({ sourceId: source.id, expectedCatalogFingerprint: 'stale' }),
    ).rejects.toMatchObject({ failure: 'stale_catalog' });
    expect(fetched).toBe(false);
  });

  it.each([
    { name: 'catalog', failure: 'stale_catalog' },
    { name: 'configured sources', failure: 'stale_sources' },
  ])('should refuse when the $name changes during the fetch', async ({ name, failure }) => {
    // Arrange
    const subject = harness();
    subject.setFeed(() => {
      subject.document.configuration =
        name === 'catalog'
          ? { ...subject.document.configuration, catalog: [manualRate('concurrent')] }
          : { ...subject.document.configuration, sources: [{ ...source, url: 'https://other.example.test/feed' }] };
      return { kind: 'feed', feed: { entries: [] } };
    });

    // Act + Assert
    await expect(
      subject.service.preview({
        sourceId: source.id,
        expectedCatalogFingerprint: analyticsPricingFingerprint([]),
      }),
    ).rejects.toMatchObject({ failure });
  });

  it('should refuse a feed whose rows cannot form one valid catalog', async () => {
    // Arrange
    const existing = manualRate('existing', 'same-model');
    const subject = harness([existing]);

    // Act + Assert
    await expect(previewWith(subject, { entries: [feedEntry('other-key', 'same-model')] })).rejects.toMatchObject({
      failure: 'invalid_catalog',
    });
  });
});

describe('AnalyticsPricingService exact preview apply', () => {
  it('should apply only selected changed rows and treat the full-result fingerprint as preview identity', async () => {
    // Arrange
    const update = manualRate('update');
    const unchanged = syncedRate('unchanged');
    const subject = harness([update, unchanged]);
    const preview = await previewWith(subject, {
      entries: [feedEntry('update'), feedEntry('unchanged'), feedEntry('add')],
    });

    // Act
    const actual = await subject.service.apply(applyRequest(preview, ['add']));

    // Assert — a selected subset intentionally has a DIFFERENT result fingerprint from the full
    // preview. Quoting that full identity proves what was reviewed; it does not assert subset output.
    expect(actual.catalogFingerprint).not.toBe(preview.resultCatalogFingerprint);
    expect(actual.catalog.find(rate => rate.pricingKey === 'update')).toEqual(update);
    expect(actual.catalog.map(rate => rate.pricingKey)).toEqual(['update', 'unchanged', 'add']);
    expect(subject.document.writes[0]).toMatchObject({
      touchedPricingKeys: ['add'],
      expectedSourcesFingerprint: analyticsPricingSourcesFingerprint([source]),
      syncedSource: { sourceId: source.id, lastSyncedAt: preview.fetchedAt },
    });
    expect(actual.sources[0]?.lastSyncedAt).toBe(preview.fetchedAt);
    await expect(subject.service.apply(applyRequest(preview, ['add']))).rejects.toMatchObject({
      failure: 'unknown_preview',
    });
  });

  it.each([
    { name: 'unknown key', selected: ['not-offered'] },
    { name: 'unchanged key', selected: ['unchanged'] },
  ])('should reject an $name rather than accept a no-op selection', async ({ selected }) => {
    // Arrange
    const unchanged = syncedRate('unchanged');
    const subject = harness([unchanged]);
    const preview = await previewWith(subject, { entries: [feedEntry('unchanged'), feedEntry('add')] });

    // Act + Assert
    await expect(subject.service.apply(applyRequest(preview, selected))).rejects.toMatchObject({
      failure: 'invalid_selection',
    });
    expect(subject.document.writes).toHaveLength(0);
  });

  it.each([
    { field: 'expectedCatalogFingerprint', value: 'other' },
    { field: 'expectedResultFingerprint', value: 'other' },
  ] as const)('should reject a preview identity with a mismatched $field', async ({ field, value }) => {
    // Arrange
    const subject = harness();
    const preview = await previewWith(subject, { entries: [feedEntry('add')] });
    const request = { ...applyRequest(preview, ['add']), [field]: value };

    // Act + Assert
    await expect(subject.service.apply(request)).rejects.toMatchObject({ failure: 'preview_mismatch' });
  });

  it('should expire a preview at its exact deadline', async () => {
    // Arrange
    const subject = harness([], [source], { previewTtlMs: 1_000 });
    const preview = await previewWith(subject, { entries: [feedEntry('add')] });
    subject.setNow('2026-02-01T00:00:01.000Z');

    // Act + Assert
    await expect(subject.service.apply(applyRequest(preview, ['add']))).rejects.toMatchObject({
      failure: 'expired_preview',
    });
    await expect(subject.service.apply(applyRequest(preview, ['add']))).rejects.toMatchObject({
      failure: 'unknown_preview',
    });
  });

  it('should invalidate a preview when a new service instance represents a daemon restart', async () => {
    // Arrange
    const beforeRestart = harness();
    const preview = await previewWith(beforeRestart, { entries: [feedEntry('add')] });
    const afterRestart = harness();

    // Act + Assert
    await expect(afterRestart.service.apply(applyRequest(preview, ['add']))).rejects.toMatchObject({
      failure: 'unknown_preview',
    });
  });

  it('should evict the oldest preview when the process-local bound is reached', async () => {
    // Arrange
    const subject = harness([], [source], { previewLimit: 2 });
    const first = await previewWith(subject, { entries: [feedEntry('one')] });
    await previewWith(subject, { entries: [feedEntry('two')] });
    const third = await previewWith(subject, { entries: [feedEntry('three')] });

    // Act + Assert
    await expect(subject.service.apply(applyRequest(first, ['one']))).rejects.toMatchObject({
      failure: 'unknown_preview',
    });
    await expect(subject.service.apply(applyRequest(third, ['three']))).resolves.toMatchObject({
      catalog: [{ pricingKey: 'three' }],
    });
  });

  it.each([
    { name: 'catalog', failure: 'stale_catalog' },
    { name: 'source authority', failure: 'stale_sources' },
  ])('should refuse when the $name drifts after preview', async ({ name, failure }) => {
    // Arrange
    const subject = harness();
    const preview = await previewWith(subject, { entries: [feedEntry('add')] });
    subject.document.configuration =
      name === 'catalog'
        ? { ...subject.document.configuration, catalog: [manualRate('concurrent')] }
        : { ...subject.document.configuration, sources: [{ ...source, enabled: false }] };

    // Act + Assert
    await expect(subject.service.apply(applyRequest(preview, ['add']))).rejects.toMatchObject({ failure });
  });

  it('should refuse a subset that is invalid without the other reviewed update', async () => {
    // Arrange — both updates together transfer `shared` from model B to model A. Applying only A
    // would leave the alias owned by two models, so subset validation has to run again.
    const first = manualRate('first', 'model-a');
    const second = manualRate('second', 'model-b', ['shared']);
    const subject = harness([first, second]);
    const preview = await previewWith(subject, {
      entries: [feedEntry('first', 'model-a', ['shared']), feedEntry('second', 'model-b', ['other'])],
    });

    // Act + Assert
    await expect(subject.service.apply(applyRequest(preview, ['first']))).rejects.toMatchObject({
      failure: 'invalid_catalog',
    });
  });

  it.each([
    { kind: 'stale_catalog', failure: 'stale_catalog' },
    { kind: 'stale_sources', failure: 'stale_sources' },
    { kind: 'unavailable', failure: 'configuration_unavailable' },
  ] as const)('should translate a $kind apply write without losing the preview refusal', async ({ kind, failure }) => {
    // Arrange
    const subject = harness();
    const preview = await previewWith(subject, { entries: [feedEntry('add')] });
    subject.document.writeResult =
      kind === 'unavailable'
        ? { kind, message: 'not writable' }
        : { kind, configuration: subject.document.configuration };

    // Act + Assert
    await expect(subject.service.apply(applyRequest(preview, ['add']))).rejects.toMatchObject({ failure });
  });
});
