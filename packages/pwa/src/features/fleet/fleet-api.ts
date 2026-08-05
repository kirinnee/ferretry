/**
 * The browser's half of the fleet configuration boundary.
 *
 * NOTHING HERE WRITES ON THE STRENGTH OF A CLICK. The daemon holds a proposal — a derived, previewed,
 * expiring change — and this module can create one, read one, and ask for exactly that one to be
 * applied. It cannot send a configuration document, cannot name a path outside the daemon's asset
 * tree, and cannot mint its own authority: the approval a paired device needs is minted on the host
 * and typed back in by the person sitting at it.
 *
 * EVERY WIRE SHAPE IS THE SHARED ONE. The schemas come from `@ferretry/protocol`, which the daemon
 * also parses its own responses through, so this browser and that daemon cannot hold two different
 * ideas of what a proposal is. The only schema declared here is the narrowed configuration read the
 * editor needs, because the full fleet document is the fleet package's contract rather than the
 * protocol's.
 *
 * Every call takes a connection-bound client. A fleet belongs to a MACHINE, and this browser can be
 * paired to several, so nothing is cached at module scope.
 */

import {
  type FleetApplyOutcome,
  FleetApplyOutcomeSchema,
  FleetApprovalCodeSchema,
  type FleetAssetDocument,
  FleetAssetDocumentSchema,
  type FleetAssetIndex,
  FleetAssetIndexSchema,
  type FleetAssetListing,
  type FleetManifestSummary,
  FleetManifestSummarySchema,
  type FleetPermissions,
  FleetPermissionsSchema,
  type FleetProposalPreview,
  type FleetProposalRequest,
  type FleetProposalView,
  FleetProposalViewSchema,
  type FleetRefusalCode,
  FleetRefusalCodeSchema,
  type FleetWriteOperation,
  type IFyApiClient,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { z } from 'zod';

/** The only client capability the fleet surface uses. */
export type FleetClient = Pick<IFyApiClient, 'request'>;

export const FLEET_PATH = '/v1/fleet';

/** The shared wire contract, re-exported so this feature has one import surface. */
export type {
  FleetApplyOutcome,
  FleetAssetDocument,
  FleetAssetIndex,
  FleetAssetListing,
  FleetManifestSummary,
  FleetPermissions,
  FleetProposalPreview,
  FleetProposalRequest,
  FleetProposalView,
  FleetWriteOperation,
};

/** One account as the manifest summary records it. */
export type FleetManifestAccountView = FleetManifestSummary['accounts'][number];

/**
 * The declared configuration, narrowed to what an editor needs: which lanes exist, and what each
 * route already carries. The full document has far more in it, and a browser that parsed all of it
 * would be a second implementation of the fleet schema drifting away from the real one.
 */
const NonEmpty = z.string().min(1);
const FleetConfigViewSchema = z.object({
  variants: z.record(z.string(), z.unknown()),
  agents: z
    .array(
      z.object({
        name: NonEmpty,
        kind: z.enum(['claude', 'codex']),
        routes: z.record(
          z.string(),
          z.object({ id: NonEmpty, wrapper: NonEmpty, layer: z.record(z.string(), z.unknown()).optional() }),
        ),
      }),
    )
    .readonly(),
});
export type FleetConfigView = z.output<typeof FleetConfigViewSchema>;

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const readFleetPermissions = async (client: FleetClient): Promise<FleetPermissions> =>
  await client.request(`${FLEET_PATH}/permissions`, FleetPermissionsSchema);

export const readFleetManifest = async (client: FleetClient): Promise<FleetManifestSummary> =>
  await client.request(`${FLEET_PATH}/accounts`, FleetManifestSummarySchema);

export const readFleetConfig = async (client: FleetClient): Promise<FleetConfigView> =>
  await client.request(`${FLEET_PATH}/config`, FleetConfigViewSchema);

export const listFleetAssets = async (client: FleetClient): Promise<FleetAssetIndex> =>
  await client.request(`${FLEET_PATH}/assets`, FleetAssetIndexSchema);

export const readFleetAsset = async (client: FleetClient, path: string): Promise<FleetAssetDocument> =>
  await client.request(`${FLEET_PATH}/assets/${encodeURIComponent(path)}`, FleetAssetDocumentSchema);

/** Derives, previews and holds a change. Writes nothing on the host. */
export const createFleetProposal = async (
  client: FleetClient,
  request: FleetProposalRequest,
): Promise<FleetProposalView> =>
  await client.request(`${FLEET_PATH}/proposals`, FleetProposalViewSchema, json(request));

/** Re-reads a held proposal, which is how the surface learns an approval is now outstanding. */
export const readFleetProposal = async (client: FleetClient, id: string): Promise<FleetProposalView> =>
  await client.request(`${FLEET_PATH}/proposals/${encodeURIComponent(id)}`, FleetProposalViewSchema);

/**
 * The typed approval code, normalised the way a person actually types it, or `null` when it is not
 * one at all.
 *
 * Checked here rather than only on the daemon because the attempt budget is small and shared: a
 * transposed character that never leaves the browser costs nothing, while the same character sent
 * spends one of the tries the host allows for that proposal. The grammar is the SHARED one, so the
 * browser and the daemon cannot disagree about what a code is.
 */
export const parseApprovalCode = (candidate: string): string | null => {
  const parsed = FleetApprovalCodeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

/**
 * Applies exactly the held proposal.
 *
 * The approval code is sent to THIS proposal's apply route and nowhere else, and it is never
 * persisted: it is a short-lived, single-use, proposal-bound value a person read off their own host.
 */
export const applyFleetProposal = async (
  client: FleetClient,
  id: string,
  approvalCode?: string,
): Promise<FleetApplyOutcome> =>
  await client.request(
    `${FLEET_PATH}/proposals/${encodeURIComponent(id)}/apply`,
    FleetApplyOutcomeSchema,
    json(approvalCode === undefined ? {} : { approvalCode }),
  );

/** Every fleet refusal the daemon spells out with a code, plus the two states a browser must infer. */
export type FleetRefusalKind =
  | 'config-missing'
  | 'config-invalid'
  | 'not-applied'
  | 'manifest-invalid'
  /**
   * The daemon answered, and the answer does not match the shared contract.
   *
   * Distinct from `unreachable` on purpose: a host that served a structurally invalid manifest is not a
   * host that said nothing, and telling a person "this daemon did not answer" about a daemon that did
   * sends them to look at the network instead of at the host.
   */
  | 'malformed'
  | 'proposal-gone'
  | 'proposal-stale'
  | 'proposal-unauthorized'
  | 'refused'
  | 'forbidden'
  | 'unreachable';

/**
 * Every shared refusal code, mapped to the state a person has to act on.
 *
 * `satisfies Record<FleetRefusalCode, …>` is the point: the day the daemon declares a new refusal, this
 * object stops compiling until somebody decides what that refusal MEANS to a reader. An open
 * `Record<string, …>` would have taken the new code silently and rendered it as a generic failure.
 */
const REFUSAL_KINDS = {
  fleet_config_missing: 'config-missing',
  fleet_config_invalid: 'config-invalid',
  fleet_not_applied: 'not-applied',
  fleet_manifest_invalid: 'manifest-invalid',
  fleet_proposal_unknown: 'proposal-gone',
  fleet_proposal_expired: 'proposal-gone',
  fleet_proposal_consumed: 'proposal-gone',
  fleet_proposal_stale: 'proposal-stale',
  fleet_proposal_unauthorized: 'proposal-unauthorized',
  fleet_proposal_refused: 'refused',
  fleet_plan_refused: 'refused',
  fleet_apply_refused: 'refused',
  fleet_asset_refused: 'refused',
  fleet_environment_refused: 'refused',
} satisfies Record<FleetRefusalCode, FleetRefusalKind>;

/**
 * The kind a code means, checked against the shared grammar at runtime as well as at compile time.
 *
 * A code this contract does not declare — a future fleet code, or an ordinary HTTP code from anywhere
 * else in the daemon — is an honest generic refusal rather than a crash or a silent blank.
 */
const refusalKindFor = (code: string | undefined): FleetRefusalKind => {
  const parsed = FleetRefusalCodeSchema.safeParse(code);
  return parsed.success ? REFUSAL_KINDS[parsed.data] : 'refused';
};

/**
 * What a daemon refusal was, and the text it said.
 *
 * The message is kept whole, newlines and all. A fleet refusal is frequently a list — every schema
 * issue in a candidate configuration, every path a rollback could not restore — and a surface that
 * squashed it to one line would hide the half the reader needs.
 */
export interface FleetRefusalView {
  readonly kind: FleetRefusalKind;
  readonly detail: string;
  readonly code?: string;
}

/**
 * The issues a schema failure carries, if that is what this is.
 *
 * The client parses every answer with `schema.parse`, so a daemon that returns a structurally invalid 200
 * throws here rather than resolving — and that error's own `message` is a multi-line JSON dump of every
 * issue. Rendered into a blocker or a state panel, a person reads JSON.
 *
 * Deliberately NOT `instanceof ZodError`: two copies of zod in one install would make that quietly false,
 * and the interesting thing is the SHAPE this boundary produced, which is what gets parsed here.
 */
const SchemaIssuesSchema = z.array(z.object({ path: z.array(z.unknown()).optional(), message: z.string() })).min(1);

/** A schema failure as one sentence naming where it happened, or `null` if this is another kind of error. */
const schemaFailureDetail = (error: unknown): string | null => {
  if (!(error instanceof Error)) return null;
  const parsed = SchemaIssuesSchema.safeParse((error as { readonly issues?: unknown }).issues);
  if (!parsed.success) return null;
  const [first, ...rest] = parsed.data;
  if (first === undefined) return null;
  const where = (first.path ?? []).map(String).join('.');
  // Collapsed, because "short sentence" has to hold even for an issue message that arrives with newlines.
  const why = first.message.replace(/\s+/gu, ' ').trim();
  const more = rest.length === 0 ? '' : ` (and ${rest.length} more)`;
  return `this daemon's answer does not match the fleet contract${where === '' ? '' : ` at ${where}`}: ${why}${more}`;
};

export const fleetRefusal = (error: unknown): FleetRefusalView => {
  const http = error instanceof FyHttpError ? error : null;
  if (http === null) {
    // An answer that arrived and did not parse is neither a refusal the daemon worded nor silence.
    const malformed = schemaFailureDetail(error);
    if (malformed !== null) return { kind: 'malformed', detail: malformed };
  }
  const detail = error instanceof Error && error.message.length > 0 ? error.message : String(error);
  const kind: FleetRefusalKind =
    http === null ? 'unreachable' : http.status === 403 ? 'forbidden' : refusalKindFor(http.code);
  return { kind, detail, ...(http?.code === undefined ? {} : { code: http.code }) };
};
