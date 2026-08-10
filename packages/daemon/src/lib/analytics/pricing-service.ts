import {
  ANALYTICS_PRICING_RATE_APPLICABILITY,
  type AnalyticsPricingCatalog,
  type AnalyticsPricingFeed,
  type AnalyticsPricingPatch,
  type AnalyticsPricingSyncApply,
  type AnalyticsPricingSyncPreview,
  type AnalyticsPricingSyncPreviewRequest,
  type AnalyticsPricingView,
  type ConfiguredAnalyticsPricingSource,
  type ConfiguredAnalyticsPricingSources,
} from '@ferretry/protocol';
import type { ClockPort, SerialExecutor } from '../ports.ts';
import {
  type AnalyticsPricingCatalogDiff,
  AnalyticsPricingCatalogError,
  AnalyticsPricingSelectionError,
  analyticsPricingFingerprint,
  analyticsPricingSourcesFingerprint,
  applyAnalyticsPricingPatch,
  applyAnalyticsPricingSelection,
  diffAnalyticsPricingCatalog,
} from './pricing-catalog.ts';

/** Ten minutes: long enough to review a bounded table and short enough that it must still be fresh. */
const ANALYTICS_PRICING_PREVIEW_TTL_MS = 10 * 60 * 1_000;

/** One daemon retains at most eight reviewed documents; the ninth evicts the oldest. */
const ANALYTICS_PRICING_PREVIEW_LIMIT = 8;

export interface AnalyticsPricingConfiguration {
  readonly catalog: AnalyticsPricingCatalog;
  readonly sources: ConfiguredAnalyticsPricingSources;
}

export type AnalyticsPricingConfigurationRead =
  | { readonly kind: 'read'; readonly configuration: AnalyticsPricingConfiguration }
  | { readonly kind: 'unavailable'; readonly message: string };

export interface AnalyticsPricingConfigurationWrite {
  readonly catalog: AnalyticsPricingCatalog;
  readonly expectedCatalogFingerprint: string;
  /** The only rows whose raw document representation may be replaced or removed. */
  readonly touchedPricingKeys: readonly string[];
  /** Present for sync apply, because the reviewed configured source is part of that decision. */
  readonly expectedSourcesFingerprint?: string;
  /** Present only after an exact reviewed preview was successfully selected for apply. */
  readonly syncedSource?: { readonly sourceId: string; readonly lastSyncedAt: string };
}

export type AnalyticsPricingConfigurationWriteResult =
  | { readonly kind: 'written'; readonly configuration: AnalyticsPricingConfiguration }
  | { readonly kind: 'stale_catalog'; readonly configuration: AnalyticsPricingConfiguration }
  | { readonly kind: 'stale_sources'; readonly configuration: AnalyticsPricingConfiguration }
  | { readonly kind: 'unavailable'; readonly message: string };

/** The pricing-only slice of the daemon configuration document. */
export interface AnalyticsPricingConfigurationPort {
  readPricing(): Promise<AnalyticsPricingConfigurationRead>;
  writePricing(input: AnalyticsPricingConfigurationWrite): Promise<AnalyticsPricingConfigurationWriteResult>;
}

/** Every bounded HTTP outcome, translated by the adapter rather than thrown across the boundary. */
export type AnalyticsPricingFeedRead =
  | { readonly kind: 'feed'; readonly feed: AnalyticsPricingFeed }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'invalid_json' }
  | { readonly kind: 'invalid_schema' };

export interface AnalyticsPricingFeedPort {
  /** The configured source object is the only address-bearing input; a request can never supply one. */
  read(source: ConfiguredAnalyticsPricingSource): Promise<AnalyticsPricingFeedRead>;
}

export interface AnalyticsPricingPreviewIdFactory {
  /** Returns an opaque identifier unique within this constructed service's lifetime. */
  next(): string;
}

export type AnalyticsPricingFailure =
  | 'configuration_unavailable'
  | 'stale_catalog'
  | 'stale_sources'
  | 'unknown_source'
  | 'disabled_source'
  | 'source_unreachable'
  | 'source_timeout'
  | 'source_status'
  | 'source_oversized'
  | 'source_invalid_json'
  | 'source_invalid_schema'
  | 'invalid_catalog'
  | 'unknown_preview'
  | 'expired_preview'
  | 'preview_mismatch'
  | 'invalid_selection';

/** A domain refusal the route can translate without interpreting infrastructure exceptions. */
export class AnalyticsPricingError extends Error {
  constructor(
    readonly failure: AnalyticsPricingFailure,
    message: string,
    readonly sourceStatus?: number,
  ) {
    super(message);
    this.name = 'AnalyticsPricingError';
  }
}

interface HeldAnalyticsPricingPreview {
  readonly preview: AnalyticsPricingSyncPreview;
  readonly sourcesFingerprint: string;
  readonly expiresAtMs: number;
}

export interface AnalyticsPricingServiceOptions {
  readonly previewTtlMs?: number;
  readonly previewLimit?: number;
}

/**
 * The four pricing decisions and their process-local preview lifecycle.
 *
 * PREVIEW STATE IS THE ONE DELIBERATE MUTABLE MEMBER. It belongs to this constructed instance — not
 * a module singleton — so one daemon start can apply only previews that exact start issued and a
 * restart invalidates them by construction. Every access to it and every catalog mutation runs
 * through the injected serial executor, making read/check/write one critical section rather than
 * three individually correct operations that can race.
 */
export class AnalyticsPricingService {
  private readonly previews = new Map<string, HeldAnalyticsPricingPreview>();
  private readonly previewTtlMs: number;
  private readonly previewLimit: number;

  constructor(
    private readonly document: AnalyticsPricingConfigurationPort,
    private readonly feed: AnalyticsPricingFeedPort,
    private readonly serial: SerialExecutor,
    private readonly clock: ClockPort,
    private readonly ids: AnalyticsPricingPreviewIdFactory,
    options: AnalyticsPricingServiceOptions = {},
  ) {
    this.previewTtlMs = options.previewTtlMs ?? ANALYTICS_PRICING_PREVIEW_TTL_MS;
    this.previewLimit = options.previewLimit ?? ANALYTICS_PRICING_PREVIEW_LIMIT;
  }

  async view(): Promise<AnalyticsPricingView> {
    return this.viewOf(await this.readConfiguration());
  }

  async patch(patch: AnalyticsPricingPatch): Promise<AnalyticsPricingView> {
    return await this.serial.runExclusive(async () => {
      const configuration = await this.readConfiguration();
      const fingerprint = analyticsPricingFingerprint(configuration.catalog);
      if (fingerprint !== patch.expectedCatalogFingerprint) {
        throw new AnalyticsPricingError('stale_catalog', 'the pricing catalog changed after this edit was composed');
      }
      const existing = new Set(configuration.catalog.map(rate => rate.pricingKey));
      const unknownRemoval = patch.operations.find(
        operation => operation.op === 'remove' && !existing.has(operation.pricingKey),
      );
      if (unknownRemoval?.op === 'remove') {
        throw new AnalyticsPricingError(
          'invalid_selection',
          `pricing key ${JSON.stringify(unknownRemoval.pricingKey)} is not in the current catalog`,
        );
      }

      let catalog: AnalyticsPricingCatalog;
      try {
        catalog = applyAnalyticsPricingPatch(configuration.catalog, patch.operations);
      } catch {
        throw new AnalyticsPricingError('invalid_catalog', 'the requested edits do not form a valid pricing catalog');
      }
      return this.viewOf(
        await this.writeConfiguration({
          catalog,
          expectedCatalogFingerprint: patch.expectedCatalogFingerprint,
          touchedPricingKeys: patch.operations.map(operation =>
            operation.op === 'upsert' ? operation.rate.pricingKey : operation.pricingKey,
          ),
        }),
      );
    });
  }

  async preview(request: AnalyticsPricingSyncPreviewRequest): Promise<AnalyticsPricingSyncPreview> {
    const base = await this.readConfiguration();
    const baseCatalogFingerprint = analyticsPricingFingerprint(base.catalog);
    if (baseCatalogFingerprint !== request.expectedCatalogFingerprint) {
      throw new AnalyticsPricingError('stale_catalog', 'the pricing catalog changed before this preview began');
    }
    const source = base.sources.find(candidate => candidate.id === request.sourceId);
    if (source === undefined) {
      throw new AnalyticsPricingError(
        'unknown_source',
        `pricing source ${JSON.stringify(request.sourceId)} is not configured on this daemon`,
      );
    }
    if (!source.enabled) {
      throw new AnalyticsPricingError(
        'disabled_source',
        `pricing source ${JSON.stringify(request.sourceId)} is disabled in this daemon's configuration`,
      );
    }
    const fetched = await this.feed.read(source);
    const feed = this.feedOrThrow(fetched);
    const baseSourcesFingerprint = analyticsPricingSourcesFingerprint(base.sources);

    return await this.serial.runExclusive(async () => {
      // Fetching is intentionally outside the critical section. Re-reading here makes a manual edit
      // or configured-source edit DURING that network call a refusal rather than a preview based on
      // state that stopped being current before it was issued.
      const current = await this.readConfiguration();
      if (analyticsPricingFingerprint(current.catalog) !== baseCatalogFingerprint) {
        throw new AnalyticsPricingError('stale_catalog', 'the pricing catalog changed while its source was fetched');
      }
      if (analyticsPricingSourcesFingerprint(current.sources) !== baseSourcesFingerprint) {
        throw new AnalyticsPricingError(
          'stale_sources',
          'the configured pricing sources changed while one was fetched',
        );
      }

      const nowMs = Date.parse(this.clock.now());
      const fetchedAt = new Date(nowMs).toISOString();
      let diff: AnalyticsPricingCatalogDiff;
      try {
        diff = diffAnalyticsPricingCatalog(current.catalog, feed, source, fetchedAt);
      } catch (error) {
        if (error instanceof AnalyticsPricingCatalogError) {
          throw new AnalyticsPricingError('invalid_catalog', error.message);
        }
        throw error;
      }
      const preview: AnalyticsPricingSyncPreview = {
        previewId: this.ids.next(),
        sourceId: source.id,
        provider: source.provider,
        sourceUrl: source.url,
        fetchedAt,
        baseCatalogFingerprint,
        resultCatalogFingerprint: analyticsPricingFingerprint(diff.resultCatalog),
        changes: diff.changes,
      };

      this.pruneExpired(nowMs);
      if (this.previews.size >= this.previewLimit) {
        const oldest = this.previews.keys().next().value;
        if (oldest !== undefined) this.previews.delete(oldest);
      }
      this.previews.set(preview.previewId, {
        preview,
        sourcesFingerprint: baseSourcesFingerprint,
        expiresAtMs: nowMs + this.previewTtlMs,
      });
      return preview;
    });
  }

  async apply(request: AnalyticsPricingSyncApply): Promise<AnalyticsPricingView> {
    return await this.serial.runExclusive(async () => {
      const held = this.previews.get(request.previewId);
      if (held === undefined) {
        throw new AnalyticsPricingError('unknown_preview', 'this daemon did not issue that pricing preview');
      }
      const nowMs = Date.parse(this.clock.now());
      if (nowMs >= held.expiresAtMs) {
        this.previews.delete(request.previewId);
        throw new AnalyticsPricingError('expired_preview', 'that pricing preview expired; fetch and review it again');
      }
      if (
        request.expectedCatalogFingerprint !== held.preview.baseCatalogFingerprint ||
        request.expectedResultFingerprint !== held.preview.resultCatalogFingerprint
      ) {
        throw new AnalyticsPricingError('preview_mismatch', 'the apply request does not identify the reviewed preview');
      }

      const configuration = await this.readConfiguration();
      if (analyticsPricingFingerprint(configuration.catalog) !== held.preview.baseCatalogFingerprint) {
        throw new AnalyticsPricingError('stale_catalog', 'the pricing catalog changed after this preview was reviewed');
      }
      if (analyticsPricingSourcesFingerprint(configuration.sources) !== held.sourcesFingerprint) {
        throw new AnalyticsPricingError(
          'stale_sources',
          'the configured pricing source changed after this preview was reviewed',
        );
      }

      let catalog: AnalyticsPricingCatalog;
      try {
        catalog = applyAnalyticsPricingSelection(
          configuration.catalog,
          held.preview.changes,
          request.selectedPricingKeys,
        );
      } catch (error) {
        if (error instanceof AnalyticsPricingSelectionError) {
          throw new AnalyticsPricingError('invalid_selection', error.message);
        }
        if (error instanceof AnalyticsPricingCatalogError) {
          throw new AnalyticsPricingError('invalid_catalog', error.message);
        }
        throw error;
      }
      const written = await this.writeConfiguration({
        catalog,
        expectedCatalogFingerprint: held.preview.baseCatalogFingerprint,
        touchedPricingKeys: request.selectedPricingKeys,
        expectedSourcesFingerprint: held.sourcesFingerprint,
        syncedSource: { sourceId: held.preview.sourceId, lastSyncedAt: held.preview.fetchedAt },
      });
      this.previews.delete(request.previewId);
      return this.viewOf(written);
    });
  }

  private async readConfiguration(): Promise<AnalyticsPricingConfiguration> {
    const read = await this.document.readPricing();
    if (read.kind === 'unavailable') {
      throw new AnalyticsPricingError('configuration_unavailable', read.message);
    }
    return read.configuration;
  }

  private async writeConfiguration(input: AnalyticsPricingConfigurationWrite): Promise<AnalyticsPricingConfiguration> {
    const written = await this.document.writePricing(input);
    if (written.kind === 'unavailable') {
      throw new AnalyticsPricingError('configuration_unavailable', written.message);
    }
    if (written.kind === 'stale_catalog') {
      throw new AnalyticsPricingError('stale_catalog', 'the pricing catalog changed before the write completed');
    }
    if (written.kind === 'stale_sources') {
      throw new AnalyticsPricingError('stale_sources', 'the configured pricing source changed before apply completed');
    }
    return written.configuration;
  }

  private feedOrThrow(read: AnalyticsPricingFeedRead): AnalyticsPricingFeed {
    switch (read.kind) {
      case 'feed':
        return read.feed;
      case 'unreachable':
        throw new AnalyticsPricingError(
          'source_unreachable',
          'this daemon could not reach the configured pricing source',
        );
      case 'timeout':
        throw new AnalyticsPricingError('source_timeout', 'the configured pricing source did not answer in time');
      case 'status':
        throw new AnalyticsPricingError(
          'source_status',
          `the configured pricing source answered HTTP ${String(read.status)}`,
          read.status,
        );
      case 'oversized':
        throw new AnalyticsPricingError(
          'source_oversized',
          'the configured pricing source exceeded the response limit',
        );
      case 'invalid_json':
        throw new AnalyticsPricingError(
          'source_invalid_json',
          'the configured pricing source did not answer with JSON',
        );
      case 'invalid_schema':
        throw new AnalyticsPricingError(
          'source_invalid_schema',
          'the configured pricing source did not answer with a Ferretry pricing feed',
        );
    }
  }

  private viewOf(configuration: AnalyticsPricingConfiguration): AnalyticsPricingView {
    return {
      catalog: configuration.catalog,
      catalogFingerprint: analyticsPricingFingerprint(configuration.catalog),
      sources: configuration.sources,
      sourcesFingerprint: analyticsPricingSourcesFingerprint(configuration.sources),
      rateApplicability: ANALYTICS_PRICING_RATE_APPLICABILITY,
    };
  }

  private pruneExpired(nowMs: number): void {
    for (const [previewId, held] of this.previews) {
      if (nowMs >= held.expiresAtMs) this.previews.delete(previewId);
    }
  }
}
