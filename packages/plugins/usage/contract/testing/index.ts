/** @ferretry/plugin-usage/contract/testing — the contract's fake and conformance suite (§7.8). */
import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import { ANALYTICS_PRICING_RATE_APPLICABILITY } from '../analytics-pricing.ts';
import type { AnalyticsPricingPatch, AnalyticsPricingView } from '../analytics-pricing-api.ts';
import { AnalyticsPricingViewSchema } from '../analytics-pricing-api.ts';
import { type AnalyticsResponse, AnalyticsResponseSchema } from '../analytics.ts';
import { type LoginId, LoginIdSchema } from '../ids.ts';
import type { LoginPause } from '../pause.ts';
import type { UsageApi } from '../port.ts';
import { type UsageFeedView, UsageFeedViewSchema } from '../feed.ts';

const AT = '2026-11-07T09:00:00.000Z' as Instant;

const emptyInsights = (query: string): AnalyticsResponse => ({
  query,
  parsed: { groupBy: [], matchers: [] },
  scope: { allSessions: true, indexed: 0, matched: 0 },
  index: {
    schemaVersion: 1,
    sessions: 0,
    tokenSessions: 0,
    transcriptSources: 0,
    indexedTranscriptSources: 0,
    pendingTranscriptSources: 0,
    sourceErrors: 0,
    refreshing: false,
  },
  kind: 'raw',
  limit: 10,
  truncated: false,
  results: [],
});

/**
 * In-memory `UsageApi`: nothing is paused, nothing is known (headroom and quota are `undefined`, never 0), the index is
 * empty, the catalog starts empty and a patch with a stale fingerprint is refused by throwing.
 */
export function fakeUsage(options: { readonly paused?: readonly LoginPause[] } = {}): UsageApi {
  const paused = options.paused ?? [];
  let catalog: AnalyticsPricingView['catalog'] = [];
  let generation = 0;
  const view = (): AnalyticsPricingView => ({
    catalog,
    modelCatalogRates: [],
    catalogFingerprint: `catalog-${String(generation)}`,
    sources: [],
    sourcesFingerprint: 'sources-0',
    rateApplicability: { ...ANALYTICS_PRICING_RATE_APPLICABILITY },
  });
  return {
    headroomPercent: async () => undefined,
    feed: async (): Promise<UsageFeedView> => ({ stale: true, accounts: [] }),
    paneLimits: async () => [],
    pauses: () => paused,
    pauseOf: login => paused.find(entry => entry.login === login),
    budgets: async () => ({ budgets: [] }),
    quota: async () => undefined,
    insights: async request => emptyInsights(request.query ?? ''),
    pricing: async () => view(),
    patchPricing: async (patch: AnalyticsPricingPatch) => {
      if (patch.expectedCatalogFingerprint !== view().catalogFingerprint) throw new Error('stale_catalog');
      for (const operation of patch.operations)
        catalog =
          operation.op === 'upsert'
            ? [...catalog.filter(rate => rate.pricingKey !== operation.rate.pricingKey), operation.rate as never]
            : catalog.filter(rate => rate.pricingKey !== operation.pricingKey);
      generation += 1;
      return view();
    },
    previewPricing: async () => {
      throw new Error('unknown_source');
    },
    applyPricing: async () => {
      throw new Error('unknown_preview');
    },
    startProfile: () => ({ state: 'running', id: 'fake', startedAt: AT, endsAt: AT }),
    profile: id => (id === 'fake' ? { state: 'running', id, startedAt: AT, endsAt: AT } : undefined),
  };
}

export const aLogin = (id: string): LoginId => LoginIdSchema.parse(id);

export function usageConformance(name: string, make: () => UsageApi): void {
  describe(`UsageApi conformance: ${name}`, () => {
    test('a login nobody measured has unknown headroom, never zero', async () => {
      expect(await make().headroomPercent('no-such-login')).toBeUndefined();
    });
    test('with nothing spent nothing is paused', () => {
      const api = make();
      expect(api.pauses()).toEqual([]);
      expect(api.pauseOf(aLogin('personal'))).toBeUndefined();
    });
    test('the feed answers the wire shape, stale until a collection has completed', async () => {
      expect(UsageFeedViewSchema.parse(await make().feed({ watched: false })).accounts).toEqual([]);
    });
    test('an insight query answers the wire shape', async () => {
      expect(AnalyticsResponseSchema.safeParse(await make().insights({ query: 'sum by (day)' })).success).toBe(true);
    });
    test('the rate catalog starts empty, so nothing is priced and a zero never reads as free', async () => {
      const view = AnalyticsPricingViewSchema.parse(await make().pricing());
      expect(view.catalog).toEqual([]);
    });
    test('a catalog patch against a stale fingerprint is refused', async () => {
      await expect(
        make().patchPricing({
          expectedCatalogFingerprint: 'stale',
          operations: [{ op: 'remove', pricingKey: 'x' }],
        }),
      ).rejects.toBeDefined();
    });
    test('a profile that was never started is not found', () => {
      expect(make().profile('never-started')).toBeUndefined();
    });
  });
}
