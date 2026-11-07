import { ApiError, type ApiRequest, type ApiResponse, jsonResponse } from '@ferretry/kernel/contract';
import {
  AnalyticsPricingPatchSchema,
  AnalyticsPricingSyncApplySchema,
  AnalyticsPricingSyncPreviewRequestSchema,
} from '../../contract/index.ts';
import { parseBody } from '../lib/body.ts';
import {
  AnalyticsPricingError,
  type AnalyticsPricingFailure,
  type AnalyticsPricingService,
} from '../lib/analytics/pricing-service.ts';

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
  if (error instanceof AnalyticsPricingError)
    throw new ApiError(FAILURE_STATUS[error.failure], error.message, `pricing_${error.failure}`);
  throw error;
}

/**
 * The owner's rate catalog (Settings › Model pricing): read, edit, and sync from a configured source in two steps. Every
 * route is operator-scoped and uncached. Preview accepts only a configured source id; apply reaches the preview this
 * process issued, never a refetch.
 */
export const pricingHandlers = (service: AnalyticsPricingService) => ({
  view: async (): Promise<ApiResponse> => jsonResponse(await service.view().catch(refuse)),
  patch: async (request: ApiRequest): Promise<ApiResponse> =>
    jsonResponse(await service.patch(await parseBody(request, AnalyticsPricingPatchSchema)).catch(refuse)),
  preview: async (request: ApiRequest): Promise<ApiResponse> =>
    jsonResponse(
      await service.preview(await parseBody(request, AnalyticsPricingSyncPreviewRequestSchema)).catch(refuse),
    ),
  apply: async (request: ApiRequest): Promise<ApiResponse> =>
    jsonResponse(await service.apply(await parseBody(request, AnalyticsPricingSyncApplySchema)).catch(refuse)),
});
