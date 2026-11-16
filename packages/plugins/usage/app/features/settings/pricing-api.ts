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
} from '../../../contract/index.ts';
import type { UsageClient } from '../../shell.ts';

/** The only client capability the pricing transport uses. */
export type AnalyticsPricingClient = UsageClient;

/** Read the complete catalog, configured sources, sync metadata, and optimistic identities. */
export async function readAnalyticsPricing(client: AnalyticsPricingClient): Promise<AnalyticsPricingView> {
  return AnalyticsPricingViewSchema.parse(await client.call('GET /v1/usage/pricing'));
}

/** Apply one structured manual edit against the catalog identity it was composed from. */
export async function patchAnalyticsPricing(
  client: AnalyticsPricingClient,
  patch: AnalyticsPricingPatch,
): Promise<AnalyticsPricingView> {
  return AnalyticsPricingViewSchema.parse(
    await client.call('PATCH /v1/usage/pricing', { body: AnalyticsPricingPatchSchema.parse(patch) }),
  );
}

/** Fetch and diff one operator-configured source by stable id; no request URL exists here. */
export async function previewAnalyticsPricingSync(
  client: AnalyticsPricingClient,
  request: AnalyticsPricingSyncPreviewRequest,
): Promise<AnalyticsPricingSyncPreview> {
  return AnalyticsPricingSyncPreviewSchema.parse(
    await client.call('POST /v1/usage/pricing/sync/preview', {
      body: AnalyticsPricingSyncPreviewRequestSchema.parse(request),
    }),
  );
}

/** Apply only the selected changed rows from the exact preview identity the operator reviewed. */
export async function applyAnalyticsPricingSync(
  client: AnalyticsPricingClient,
  request: AnalyticsPricingSyncApply,
): Promise<AnalyticsPricingView> {
  return AnalyticsPricingViewSchema.parse(
    await client.call('POST /v1/usage/pricing/sync/apply', { body: AnalyticsPricingSyncApplySchema.parse(request) }),
  );
}
