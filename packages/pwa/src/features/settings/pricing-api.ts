import {
  type AnalyticsPricingPatch,
  AnalyticsPricingPatchSchema,
  type AnalyticsPricingSyncApply,
  AnalyticsPricingSyncApplySchema,
  type AnalyticsPricingSyncPreview,
  type AnalyticsPricingSyncPreviewRequest,
  AnalyticsPricingSyncPreviewRequestSchema,
  AnalyticsPricingSyncPreviewSchema,
  type AnalyticsPricingView,
  AnalyticsPricingViewSchema,
  type IFyApiClient,
} from '@ferretry/protocol';

/** The only client capability the pricing transport uses. */
export type AnalyticsPricingClient = Pick<IFyApiClient, 'request'>;

export const ANALYTICS_PRICING_PATH = '/v1/analytics/pricing';

/** Read the complete catalog, configured sources, sync metadata, and optimistic identities. */
export async function readAnalyticsPricing(client: AnalyticsPricingClient): Promise<AnalyticsPricingView> {
  return await client.request(ANALYTICS_PRICING_PATH, AnalyticsPricingViewSchema);
}

/** Apply one structured manual edit against the catalog identity it was composed from. */
export async function patchAnalyticsPricing(
  client: AnalyticsPricingClient,
  patch: AnalyticsPricingPatch,
): Promise<AnalyticsPricingView> {
  return await client.request(ANALYTICS_PRICING_PATH, AnalyticsPricingViewSchema, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(AnalyticsPricingPatchSchema.parse(patch)),
  });
}

/** Fetch and diff one operator-configured source by stable id; no request URL exists here. */
export async function previewAnalyticsPricingSync(
  client: AnalyticsPricingClient,
  request: AnalyticsPricingSyncPreviewRequest,
): Promise<AnalyticsPricingSyncPreview> {
  return await client.request(`${ANALYTICS_PRICING_PATH}/sync/preview`, AnalyticsPricingSyncPreviewSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(AnalyticsPricingSyncPreviewRequestSchema.parse(request)),
  });
}

/** Apply only the selected changed rows from the exact preview identity the operator reviewed. */
export async function applyAnalyticsPricingSync(
  client: AnalyticsPricingClient,
  request: AnalyticsPricingSyncApply,
): Promise<AnalyticsPricingView> {
  return await client.request(`${ANALYTICS_PRICING_PATH}/sync/apply`, AnalyticsPricingViewSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(AnalyticsPricingSyncApplySchema.parse(request)),
  });
}
