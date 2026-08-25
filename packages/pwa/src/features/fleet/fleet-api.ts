/**
 * The browser's half of the fleet configuration boundary.
 *
 * NOTHING HERE WRITES ON THE STRENGTH OF A CLICK. The daemon holds a proposal — a derived, previewed,
 * expiring change — and this module can create one, read one, and ask for exactly that one to be
 * applied. It cannot send a configuration document, cannot name a path outside the daemon's asset
 * tree, and cannot mint its own authority: whether a governed caller may apply at all is
 * `fleet.configure` as the operator's grants decided it, and the per-change confirmation is the SAME
 * operator password the grants surface asks for, spent on this one staged change.
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

import { type AccountPickerHealthCatalog, readAccountPickerHealth } from '../../lib/account-picker-catalog.ts';
import {
  type FleetApplyOutcome,
  FleetApplyOutcomeSchema,
  type FleetAssetDocument,
  FleetAssetDocumentSchema,
  type FleetAssetIndex,
  FleetAssetIndexSchema,
  type FleetAssetListing,
  type FleetChangeConfirmation,
  type FleetManifestSummary,
  FleetManifestSummarySchema,
  type FleetPermissions,
  FleetPermissionsSchema,
  type FleetProfileCatalog,
  FleetProfileCatalogSchema,
  FleetProposalApplyRequestSchema,
  type FleetProposalPreview,
  type FleetProposalRequest,
  type FleetProposalView,
  FleetProposalViewSchema,
  type FleetRefusalCode,
  FleetRefusalCodeSchema,
  type FleetWriteOperation,
  type HarnessDiscovery,
  type HarnessDiscoveryReport,
  HarnessDiscoveryReportSchema,
  type IFyApiClient,
  OPERATOR_UNLOCK_HEADER,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { z } from 'zod';
import { type GrantRefusalNotice, grantRefusalNotice } from '../../lib/grants.ts';

/** The only client capability the fleet surface uses. */
export type FleetClient = Pick<IFyApiClient, 'request'>;

export const FLEET_PATH = '/v1/fleet';

/** The shared wire contract, re-exported so this feature has one import surface. */
export type {
  FleetApplyOutcome,
  FleetAssetDocument,
  FleetAssetIndex,
  FleetAssetListing,
  FleetChangeConfirmation,
  FleetManifestSummary,
  FleetPermissions,
  FleetProfileCatalog,
  FleetProposalPreview,
  FleetProposalRequest,
  FleetProposalView,
  FleetWriteOperation,
  HarnessDiscovery,
  HarnessDiscoveryReport,
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

/**
 * WHAT THIS CALLER MAY DO, asked AS the caller it currently is.
 *
 * The unlock is optional and it changes the answer, which is the whole reason it is here: a held unlock
 * makes a loopback caller ungoverned, so the daemon stops asking for a per-change confirmation — and a
 * panel that read this route without the token it holds would go on claiming a password was owed and
 * prompting for one, while the apply beside it needed nothing. That is precisely the "one gate at the
 * door, then full authority" shape `docs/grants.md` describes, reported wrongly by the surface.
 *
 * The DAEMON is asked rather than the answer inferred. This browser cannot decide what an unlock buys —
 * a remote caller still owes the confirmation with one held, and only the host knows which caller this is.
 */
export const readFleetPermissions = async (client: FleetClient, unlock?: string): Promise<FleetPermissions> =>
  await client.request(
    `${FLEET_PATH}/permissions`,
    FleetPermissionsSchema,
    unlock === undefined ? undefined : { headers: { [OPERATOR_UNLOCK_HEADER]: unlock } },
  );

export const readFleetManifest = async (client: FleetClient): Promise<FleetManifestSummary> =>
  await client.request(`${FLEET_PATH}/accounts`, FleetManifestSummarySchema);

/**
 * What this HOST has, as opposed to what this fleet publishes.
 *
 * Read once when the account form opens, and read fresh: the daemon resolves `PATH` and the harness's
 * own settings at the moment it is asked, so somebody who installs Claude Code and reopens the form is
 * told what the machine has now rather than what it had when the daemon started.
 */
export const readFleetHarnesses = async (client: FleetClient): Promise<HarnessDiscoveryReport> =>
  await client.request(`${FLEET_PATH}/harnesses`, HarnessDiscoveryReportSchema);

/**
 * The stored health verdicts, for the roster on this screen.
 *
 * A SNAPSHOT READ, and that is why a configuration screen may make it at all: the daemon answers from
 * its own file and checks nothing, so opening this panel cannot cost a provider call. The route that
 * COLLECTS is a different verb on a different path, and this module deliberately does not dial it — a
 * configuration screen has no business collecting evidence.
 *
 * DELEGATES rather than declaring a second reader, so this screen and the account picker cannot come
 * to disagree about how a damaged snapshot is handled: one parser, one duplicate-row rule, one place
 * that decides a repeated account is ambiguous rather than last-one-wins.
 */
export const readFleetAccountHealth = async (client: FleetClient): Promise<AccountPickerHealthCatalog> =>
  await readAccountPickerHealth(client);

/**
 * The profiles this fleet declares, in shapes.
 *
 * A SEPARATE READ from the configuration beside it, and deliberately not a slice of it. The declared
 * document carries every environment value a profile sets as text; this answer carries the SHAPE of
 * each — a literal with no text at all, the variable an `$NAME` reads, or the secrets a `${secret:…}`
 * binds — which is the only form this browser has any business rendering. `docs/secrets.md` is why:
 * a value reaches exactly one place, and it is not a screen.
 */
export const readFleetProfiles = async (client: FleetClient): Promise<FleetProfileCatalog> =>
  await client.request(`${FLEET_PATH}/profiles`, FleetProfileCatalogSchema);

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

/**
 * Re-reads a held proposal, which is how the surface learns the host moved under a staged change.
 *
 * It carries no authority state any more, and there is nothing to poll FOR: a proposal is applied by
 * the caller that staged it, in one call, so the only reason to look again is to find out whether the
 * daemon still holds this one.
 */
export const readFleetProposal = async (client: FleetClient, id: string): Promise<FleetProposalView> =>
  await client.request(`${FLEET_PATH}/proposals/${encodeURIComponent(id)}`, FleetProposalViewSchema);

/**
 * Applies exactly the held proposal.
 *
 * TWO DIFFERENT USES OF ONE SECRET, and they are not interchangeable. `unlock` is the five-minute
 * token a mint produced, and it travels in the header the dispatcher reads for every governed route —
 * so a locked caller stops being locked. `operatorPassword` is the per-change confirmation and is the
 * PASSWORD ITSELF, proved again against this one staged change, which is why a borrowed unlock is not
 * by itself enough to provision a host. Neither is persisted or echoed anywhere, and the password
 * travels in a body because a query parameter reaches every proxy's access log.
 *
 * The body is parsed through the SHARED request schema on the way out, so a value this browser would
 * send that the daemon would refuse fails here — at the call — rather than as a 400 a person reads as
 * a broken panel.
 */
export const applyFleetProposal = async (
  client: FleetClient,
  id: string,
  confirmation?: { readonly operatorPassword?: string; readonly unlock?: string },
): Promise<FleetApplyOutcome> => {
  const password = confirmation?.operatorPassword;
  const unlock = confirmation?.unlock;
  return await client.request(`${FLEET_PATH}/proposals/${encodeURIComponent(id)}/apply`, FleetApplyOutcomeSchema, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(unlock === undefined ? {} : { [OPERATOR_UNLOCK_HEADER]: unlock }),
    },
    body: JSON.stringify(
      FleetProposalApplyRequestSchema.parse(password === undefined ? {} : { operatorPassword: password }),
    ),
  });
};

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
 *
 * ## THE CODE, NEVER THE STATUS, AND THAT IS DELIBERATE
 *
 * Every `FleetRefusal` leaves the daemon as HTTP 409 — `respond()` in `runtime/mounts/fleet.ts` maps all
 * of them — so "you conflict with existing state" and "there is nothing here yet" arrive with the same
 * status. A never-configured host answers 409 `fleet_config_missing` on `/config` and 409
 * `fleet_not_applied` on `/accounts`, which is the ORDINARY STARTING STATE of every new install, and a
 * browser that branched on the status would render the first thing a person ever sees as a failure.
 *
 * The status is not being changed to fix that, and the reason is not inertia: the code is the contract's
 * declared discriminator, it is exhaustive here (`satisfies Record<FleetRefusalCode, …>` stops this
 * object compiling the day a new one is declared), and a status is a coarse channel every refusal shares.
 * Moving these two to 404 would be a breaking change to a shipped wire contract that other clients may
 * branch on, in exchange for nothing this browser needs. `classifyInventory` turns the pair into
 * `uninitialized`, which is a first run rather than an error.
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
  /**
   * The OPERATOR's refusal, when this 403 is one.
   *
   * A `forbidden` on its own could mean three different things a person acts on differently — this
   * credential is not allowed to, the operator switched the capability off, or the operator password
   * is needed — and a flat "READ ONLY" badge collapses all three into a dead end. When the daemon
   * names one of them with a `grant_*` code, it is carried here so a surface can say WHICH and offer
   * the next step rather than greying a control out.
   */
  readonly grant?: GrantRefusalNotice;
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
  const grant = grantRefusalNotice(error);
  return {
    kind,
    detail,
    ...(http?.code === undefined ? {} : { code: http.code }),
    ...(grant === null ? {} : { grant }),
  };
};
