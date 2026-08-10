import {
  type AnalyticsPricingPatch,
  AnalyticsPricingPatchSchema,
  type AnalyticsPricingSyncApply,
  AnalyticsPricingSyncApplySchema,
  type AnalyticsPricingSyncPreview,
  type AnalyticsPricingSyncPreviewRequest,
  AnalyticsPricingSyncPreviewRequestSchema,
  type AnalyticsPricingView,
} from '@ferretry/protocol';
import { AnalyticsPricingError, type AnalyticsPricingFailure } from '../../analytics/pricing-service.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/** The four pricing decisions the HTTP boundary makes reachable. */
export interface AnalyticsPricingSubsystem {
  view(): Promise<AnalyticsPricingView>;
  patch(patch: AnalyticsPricingPatch): Promise<AnalyticsPricingView>;
  preview(request: AnalyticsPricingSyncPreviewRequest): Promise<AnalyticsPricingSyncPreview>;
  apply(request: AnalyticsPricingSyncApply): Promise<AnalyticsPricingView>;
}

const FAILURE_STATUS = {
  configuration_unavailable: 503,
  stale_catalog: 409,
  stale_sources: 409,
  unknown_source: 404,
  disabled_source: 409,
  source_unreachable: 502,
  source_timeout: 504,
  source_status: 502,
  source_oversized: 502,
  source_invalid_json: 502,
  source_invalid_schema: 502,
  invalid_catalog: 409,
  unknown_preview: 404,
  expired_preview: 410,
  preview_mismatch: 409,
  invalid_selection: 409,
} as const satisfies Readonly<Record<AnalyticsPricingFailure, number>>;

function refuse(error: unknown): never {
  if (error instanceof AnalyticsPricingError) {
    throw new ApiError(FAILURE_STATUS[error.failure], error.message, `analytics_pricing_${error.failure}`);
  }
  throw error;
}

async function patchPricing(subsystem: AnalyticsPricingSubsystem, context: RouteContext): Promise<ApiResponse> {
  const patch = await parseBody(context.request, AnalyticsPricingPatchSchema);
  return jsonResponse(await subsystem.patch(patch).catch(refuse));
}

async function previewPricing(subsystem: AnalyticsPricingSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, AnalyticsPricingSyncPreviewRequestSchema);
  return jsonResponse(await subsystem.preview(request).catch(refuse));
}

async function applyPricing(subsystem: AnalyticsPricingSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, AnalyticsPricingSyncApplySchema);
  return jsonResponse(await subsystem.apply(request).catch(refuse));
}

/**
 * Analytics pricing Settings/API surface.
 *
 * Every route is operator-scoped and uncached: it exposes operator configuration, and both previews
 * and fingerprints are point-in-time identities. Preview accepts only a configured source id; apply
 * reaches the same constructed subsystem instance and therefore the exact process-local preview it
 * issued, never a refetch.
 */
export function analyticsPricingRoutes(subsystem: AnalyticsPricingSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/analytics/pricing',
      minimum: 'operator',
      noStore: true,
      handle: async () => jsonResponse(await subsystem.view().catch(refuse)),
    },
    {
      method: 'PATCH',
      path: '/v1/analytics/pricing',
      minimum: 'operator',
      noStore: true,
      handle: async context => await patchPricing(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/analytics/pricing/sync/preview',
      minimum: 'operator',
      noStore: true,
      handle: async context => await previewPricing(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/analytics/pricing/sync/apply',
      minimum: 'operator',
      noStore: true,
      handle: async context => await applyPricing(subsystem, context),
    },
  ];
}
