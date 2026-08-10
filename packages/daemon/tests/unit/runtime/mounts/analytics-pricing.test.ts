import { describe, expect, it } from 'bun:test';
import {
  ANALYTICS_PRICING_RATE_APPLICABILITY,
  type AnalyticsPricingPatch,
  type AnalyticsPricingSyncApply,
  type AnalyticsPricingSyncPreviewRequest,
  AnalyticsPricingSyncPreviewSchema,
  AnalyticsPricingViewSchema,
} from '@ferretry/protocol';
import { AnalyticsPricingError } from '../../../../src/lib/analytics/pricing-service.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  type AnalyticsPricingSubsystem,
  analyticsPricingRoutes,
} from '../../../../src/lib/runtime/mounts/analytics-pricing.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, human } from './support.ts';

const view = {
  catalog: [],
  catalogFingerprint: 'catalog-empty',
  sources: [],
  sourcesFingerprint: 'sources-empty',
  rateApplicability: ANALYTICS_PRICING_RATE_APPLICABILITY,
} as const;

const preview = {
  previewId: 'preview-1',
  sourceId: 'openai-feed',
  provider: 'openai',
  sourceUrl: 'https://pricing.example.test/openai.json',
  fetchedAt: '2026-08-06T12:00:00.000Z',
  baseCatalogFingerprint: 'catalog-empty',
  resultCatalogFingerprint: 'catalog-next',
  changes: [],
} as const;

function subsystem(overrides: Partial<AnalyticsPricingSubsystem> = {}): AnalyticsPricingSubsystem {
  return {
    view: async () => view,
    patch: async () => view,
    preview: async () => preview,
    apply: async () => view,
    ...overrides,
  };
}

function mount(subject: AnalyticsPricingSubsystem): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(analyticsPricingRoutes(subject)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

const bodyRequest = (method: 'PATCH' | 'POST', path: string, body: unknown) =>
  request({ method, path, headers: human, loopback: false, body: JSON.stringify(body) });

describe('analytics pricing route declarations', () => {
  it('should mount all four operator-only, no-store endpoints under the analytics namespace', () => {
    // Arrange + Act
    const actual = analyticsPricingRoutes(subsystem());

    // Assert
    expect(actual.map(route => [route.method, route.path])).toEqual([
      ['GET', '/v1/analytics/pricing'],
      ['PATCH', '/v1/analytics/pricing'],
      ['POST', '/v1/analytics/pricing/sync/preview'],
      ['POST', '/v1/analytics/pricing/sync/apply'],
    ]);
    expect(actual.every(route => route.minimum === 'operator' && route.noStore === true)).toBe(true);
  });
});

describe('analytics pricing route requests', () => {
  it('should parse and dispatch every route with the protocol-owned DTOs', async () => {
    // Arrange
    const seen: unknown[] = [];
    const dispatcher = mount(
      subsystem({
        patch: async (input: AnalyticsPricingPatch) => {
          seen.push(input);
          return view;
        },
        preview: async (input: AnalyticsPricingSyncPreviewRequest) => {
          seen.push(input);
          return preview;
        },
        apply: async (input: AnalyticsPricingSyncApply) => {
          seen.push(input);
          return view;
        },
      }),
    );
    const patch = {
      expectedCatalogFingerprint: 'catalog-empty',
      operations: [{ op: 'remove', pricingKey: 'old-rate' }],
    } as const;
    const previewRequest = { sourceId: 'openai-feed', expectedCatalogFingerprint: 'catalog-empty' };
    const apply = {
      previewId: 'preview-1',
      expectedCatalogFingerprint: 'catalog-empty',
      expectedResultFingerprint: 'catalog-next',
      selectedPricingKeys: ['new-rate'],
    };

    // Act
    const answers = await Promise.all([
      dispatcher.dispatch(request({ path: '/v1/analytics/pricing', headers: human, loopback: false })),
      dispatcher.dispatch(bodyRequest('PATCH', '/v1/analytics/pricing', patch)),
      dispatcher.dispatch(bodyRequest('POST', '/v1/analytics/pricing/sync/preview', previewRequest)),
      dispatcher.dispatch(bodyRequest('POST', '/v1/analytics/pricing/sync/apply', apply)),
    ]);

    // Assert
    expect(answers.map(answer => answer.status)).toEqual([200, 200, 200, 200]);
    expect(AnalyticsPricingViewSchema.parse(jsonBody(answers[0]))).toEqual(view);
    expect(AnalyticsPricingSyncPreviewSchema.parse(jsonBody(answers[2]))).toEqual(preview);
    expect(seen).toEqual([patch, previewRequest, apply]);
  });

  it('should reject malformed bodies before the subsystem can act', async () => {
    // Arrange
    let called = false;
    const dispatcher = mount(
      subsystem({
        patch: async () => {
          called = true;
          return view;
        },
      }),
    );

    // Act
    const actual = await dispatcher.dispatch(
      bodyRequest('PATCH', '/v1/analytics/pricing', {
        expectedCatalogFingerprint: 'catalog-empty',
        operations: [{ op: 'upsert', rate: { source: { kind: 'provider_sync' } } }],
      }),
    );

    // Assert
    expect(actual.status).toBe(400);
    expect(called).toBe(false);
  });

  it('should require an operator credential', async () => {
    // Arrange
    const dispatcher = mount(subsystem());

    // Act
    const actual = await dispatcher.dispatch(request({ path: '/v1/analytics/pricing', loopback: false }));

    // Assert
    expect(actual.status).toBe(401);
  });
});

describe('analytics pricing route refusals', () => {
  it.each([
    ['configuration_unavailable', 503],
    ['stale_catalog', 409],
    ['stale_sources', 409],
    ['unknown_source', 404],
    ['disabled_source', 409],
    ['source_unreachable', 502],
    ['source_timeout', 504],
    ['source_status', 502],
    ['source_oversized', 502],
    ['source_invalid_json', 502],
    ['source_invalid_schema', 502],
    ['invalid_catalog', 409],
    ['unknown_preview', 404],
    ['expired_preview', 410],
    ['preview_mismatch', 409],
    ['invalid_selection', 409],
  ] as const)('should translate %s to its narrow API refusal', async (failure, status) => {
    // Arrange
    const dispatcher = mount(
      subsystem({
        view: async () => {
          throw new AnalyticsPricingError(
            failure,
            `refused: ${failure}`,
            failure === 'source_status' ? 503 : undefined,
          );
        },
      }),
    );

    // Act
    const actual = await dispatcher.dispatch(
      request({ path: '/v1/analytics/pricing', headers: human, loopback: false }),
    );

    // Assert
    expect(actual.status).toBe(status);
    expect(jsonBody(actual)).toMatchObject({ code: `analytics_pricing_${failure}`, error: `refused: ${failure}` });
  });

  it('should leave an unexpected exception as a server fault', async () => {
    // Arrange
    const dispatcher = mount(
      subsystem({
        view: async () => {
          throw new Error('programming defect');
        },
      }),
    );

    // Act
    const actual = await dispatcher.dispatch(
      request({ path: '/v1/analytics/pricing', headers: human, loopback: false }),
    );

    // Assert
    expect(actual.status).toBe(500);
  });
});
