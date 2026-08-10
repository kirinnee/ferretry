import { describe, expect, it } from 'bun:test';
import {
  ANALYTICS_PRICING_RATE_APPLICABILITY,
  type AnalyticsPricingRate,
  type AnalyticsPricingSyncPreview,
  type AnalyticsPricingView,
} from '@ferretry/protocol';
import {
  ANALYTICS_PRICING_PATH,
  applyAnalyticsPricingSync,
  patchAnalyticsPricing,
  previewAnalyticsPricingSync,
  readAnalyticsPricing,
} from '../../../../src/features/settings/pricing-api.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

const rate: AnalyticsPricingRate = {
  pricingKey: 'manual:gpt-5:2026-08',
  modelId: 'gpt-5',
  aliases: [],
  provider: 'openai',
  currency: 'USD',
  rates: {
    input: 1,
    output: 2,
    cachedInput: 1,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: 3,
    image: null,
    tool: null,
  },
  source: { kind: 'manual' },
  validFrom: '2026-08-01T00:00:00.000Z',
  validThrough: null,
  verifiedAt: '2026-08-01T00:00:00.000Z',
  lastSyncedAt: null,
};

const view: AnalyticsPricingView = {
  catalog: [rate],
  catalogFingerprint: 'catalog-current',
  sources: [
    {
      id: 'openai-feed',
      provider: 'openai',
      url: 'https://pricing.example.test/openai.json',
      enabled: true,
      lastSyncedAt: null,
    },
  ],
  sourcesFingerprint: 'sources-current',
  rateApplicability: ANALYTICS_PRICING_RATE_APPLICABILITY,
};

const preview: AnalyticsPricingSyncPreview = {
  previewId: 'preview-1',
  sourceId: 'openai-feed',
  provider: 'openai',
  sourceUrl: 'https://pricing.example.test/openai.json',
  fetchedAt: '2026-08-06T12:00:00.000Z',
  baseCatalogFingerprint: 'catalog-current',
  resultCatalogFingerprint: 'catalog-preview-result',
  changes: [],
};

function recorder(answers: readonly unknown[]) {
  const calls: Call[] = [];
  let answer = 0;
  return {
    calls,
    client: {
      request: (async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
        calls.push({ path, init });
        return schema.parse(answers[answer++]);
      }) as never,
    },
  };
}

describe('analytics pricing transport', () => {
  it('should call every daemon route with the agreed path, verb, request, and response schema', async () => {
    // Arrange
    const { calls, client } = recorder([view, view, preview, view]);
    const patch = {
      expectedCatalogFingerprint: view.catalogFingerprint,
      operations: [{ op: 'upsert', rate }],
    } as const;
    const previewRequest = {
      sourceId: 'openai-feed',
      expectedCatalogFingerprint: view.catalogFingerprint,
    };
    const apply = {
      previewId: preview.previewId,
      expectedCatalogFingerprint: preview.baseCatalogFingerprint,
      expectedResultFingerprint: preview.resultCatalogFingerprint,
      selectedPricingKeys: ['openai:gpt-5:2026-08'],
    };

    // Act
    const answers = await Promise.all([
      readAnalyticsPricing(client),
      patchAnalyticsPricing(client, patch),
      previewAnalyticsPricingSync(client, previewRequest),
      applyAnalyticsPricingSync(client, apply),
    ]);

    // Assert
    expect(answers).toEqual([view, view, preview, view]);
    expect(calls.map(call => [call.init?.method ?? 'GET', call.path])).toEqual([
      ['GET', ANALYTICS_PRICING_PATH],
      ['PATCH', ANALYTICS_PRICING_PATH],
      ['POST', `${ANALYTICS_PRICING_PATH}/sync/preview`],
      ['POST', `${ANALYTICS_PRICING_PATH}/sync/apply`],
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(patch);
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual(previewRequest);
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual(apply);
  });

  it('should reject provider-sync provenance in a manual patch before making a call', async () => {
    // Arrange
    const { calls, client } = recorder([view]);
    const forged: AnalyticsPricingRate = {
      ...rate,
      source: {
        kind: 'provider_sync',
        provider: 'openai',
        sourceUrl: 'https://pricing.example.test/openai.json',
      },
      lastSyncedAt: '2026-08-06T12:00:00.000Z',
    };

    // Act + Assert
    await expect(
      patchAnalyticsPricing(client, {
        expectedCatalogFingerprint: view.catalogFingerprint,
        operations: [{ op: 'upsert', rate: forged }],
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('should reject a preview request URL because only a configured source id may travel', async () => {
    // Arrange
    const { calls, client } = recorder([preview]);

    // Act + Assert
    await expect(
      previewAnalyticsPricingSync(client, {
        sourceId: 'openai-feed',
        expectedCatalogFingerprint: view.catalogFingerprint,
        sourceUrl: 'https://attacker.example.test/prices.json',
      } as never),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('should parse daemon responses instead of casting them', async () => {
    // Arrange
    const { client } = recorder([{ ...view, rateApplicability: { input: 'applied_when_evidenced' } }]);

    // Act + Assert
    await expect(readAnalyticsPricing(client)).rejects.toThrow();
  });
});
