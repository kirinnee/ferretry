/**
 * Installing a catalog item from a signed file: `/v1/catalog-installs`. The domain is
 * `catalog-installs/service.ts`; the wire is `@ferretry/protocol` catalog-install.
 *
 * ONE ROUTE PER SCOPE, because a route declares exactly one capability and the scopes are governed by
 * different ones: a project is the person's repository (`filesystem`), a runtime is the fleet (`fleet`).
 * A preview is a read with a body (`use`); an apply or a removal changes something (`configure`).
 *
 * WHO MAY. A ferret may preview and list: it writes nothing. It may NOT install or remove — an item is
 * instructions a ferret would follow and a program this machine would run, and a ferret that could add
 * one could hand itself a way around everything else. That is the owner's act, refused before a body is
 * read. A governed device installs only with a passkey proved for THIS act (`catalog-install`) — never
 * the unlock's, which opens the machine and is not a proof for an act — and the proof is CLAIMED
 * atomically at admission, so one confirmation buys one install even when two applies race. The machine's
 * own `fy` is ungoverned and its CLI asks y/N instead. Removing never asks for a passkey: taking
 * something away is the safe direction.
 *
 * A PREVIEW BELONGS TO ITS CALLER. It is applied only by the caller that reviewed it (a paired device, the
 * host, or a ferret), so one caller cannot apply, or evict, what another reviewed.
 *
 * The deeper `preview` paths are registered before the scope paths so no pattern shadows another.
 */
import {
  CATALOG_INSTALL_PREVIEW_MAX_BODY_BYTES,
  type CatalogInstalled,
  CatalogInstallIdSchema,
  type CatalogInstallList,
  type CatalogInstallPreview,
  CatalogInstallPreviewRequestSchema,
  CatalogInstallRequestSchema,
  type CatalogInstallRemoved,
  type CatalogInstallRefusal,
  type CatalogInstallScope,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import { isAgentCaller } from '../../api/agent-caller.ts';
import { parseBody } from '../../api/body.ts';
import type { CallerGovernance, CapabilityDemand } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { CatalogInstallRefusalError } from '../../catalog-installs/ports.ts';
import { CatalogInstallStateError } from '../../catalog-installs/store.ts';
import type { CatalogInstallPreviewRequest, CatalogInstallRequest } from '@ferretry/protocol';
import type { CatalogCaller } from '../../catalog-installs/service.ts';
import { FleetCatalogRefusal, type FreshStepUpContext } from '../../fleet/catalog-service.ts';

/** The seven acts, from the parsed request to the answer the caller sees. */
export interface CatalogInstallSubsystem {
  list(): Promise<CatalogInstallList>;
  preview(
    scope: CatalogInstallScope,
    request: CatalogInstallPreviewRequest,
    caller: CatalogCaller,
  ): Promise<CatalogInstallPreview>;
  apply(
    scope: CatalogInstallScope,
    request: CatalogInstallRequest,
    caller: CatalogCaller,
    governance: CallerGovernance | undefined,
  ): Promise<CatalogInstalled>;
  remove(
    scope: CatalogInstallScope,
    installId: string,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<CatalogInstallRemoved>;
}

const FILESYSTEM_USE: CapabilityDemand = { capability: 'filesystem', axis: 'use' };
const FILESYSTEM_CONFIGURE: CapabilityDemand = { capability: 'filesystem', axis: 'configure' };
const FLEET_USE: CapabilityDemand = { capability: 'fleet', axis: 'use' };
const FLEET_CONFIGURE: CapabilityDemand = { capability: 'fleet', axis: 'configure' };
const SECRETS_USE: CapabilityDemand = { capability: 'secrets', axis: 'use' };

const demandFor = (scope: CatalogInstallScope): CapabilityDemand =>
  scope === 'project' ? FILESYSTEM_CONFIGURE : FLEET_CONFIGURE;

/** Each refusal's HTTP status. A wrong request is 4xx, a thing in the way is 409, and a missing one is 404. */
const REFUSAL_STATUS: Readonly<Record<CatalogInstallRefusal, number>> = {
  catalog_signature_invalid: 422,
  catalog_item_mismatch: 422,
  catalog_publisher_changed: 409,
  catalog_revision_older: 409,
  catalog_downgrade: 409,
  catalog_item_invalid: 422,
  catalog_not_installable: 422,
  catalog_target_unknown: 404,
  catalog_preview_unknown: 404,
  catalog_preview_expired: 410,
  catalog_bindings_invalid: 422,
  catalog_install_conflict: 409,
  catalog_install_unknown: 404,
};

/** Restates a refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof CatalogInstallRefusalError)
    throw new ApiError(REFUSAL_STATUS[error.code], error.message, error.code);
  if (error instanceof FleetCatalogRefusal)
    throw new ApiError(error.code === 'fleet_change_unknown' ? 404 : 409, error.message, error.code);
  if (error instanceof CatalogInstallStateError) throw new ApiError(500, error.message, 'catalog_installs_unreadable');
  throw error;
}

async function answer(work: () => Promise<unknown>): Promise<ApiResponse> {
  return jsonResponse(await work().catch(refuse));
}

function ownerOnly(context: RouteContext, act: string): void {
  if (isAgentCaller(context)) throw new ApiError(403, `a ferret cannot ${act}; the owner does`, 'forbidden');
}

/**
 * Who is asking, as a preview and its apply must agree: a paired device by its id, any ferret as one
 * caller, and the host's own shell as another. Derived from the credential, never from the body.
 */
function callerOf(context: RouteContext): CatalogCaller {
  const credential = context.credential;
  const id =
    credential?.tokenClass === 'device' ? `device:${credential.deviceId}` : isAgentCaller(context) ? 'agents' : 'host';
  // The same rule as listing secrets: the `secrets` capability's `use` axis for this caller.
  return { id, mayListSecrets: context.governance?.decide(SECRETS_USE).allowed === true };
}

/**
 * Claims the passkey proof for this act, atomically, and answers the refusal when a governed caller holds
 * none (or someone else already spent it). `undefined` means it may go on; an ungoverned caller needs none.
 */
function claimPasskey(context: RouteContext, scope: CatalogInstallScope): ApiResponse | undefined {
  if (context.governance?.governed !== true || context.claimFreshStepUp?.() === true) return undefined;
  return jsonResponse(
    {
      error: 'installing from a catalog needs a passkey confirmation for it, from this device',
      code: STEP_UP_REQUIRED_CODE,
      demand: { ...demandFor(scope), act: STEP_UP_ACTS.catalogInstall },
    } satisfies StepUpRequiredBody,
    403,
  );
}

const freshStepUpOf = (context: RouteContext): FreshStepUpContext => ({
  presentation: context.presentation,
  spend: () => context.spendFreshStepUp?.(),
});

function installId(context: RouteContext): string {
  const parsed = CatalogInstallIdSchema.safeParse(decodeParameter(context.params.get('installId') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the install id in the path is not usable', 'invalid_install_id');
  return parsed.data;
}

type Handler = ApiRoute['handle'];

const previewHandler =
  (scope: CatalogInstallScope, subsystem: CatalogInstallSubsystem): Handler =>
  async context => {
    const request = await parseBody(context.request, CatalogInstallPreviewRequestSchema, {
      maxBytes: CATALOG_INSTALL_PREVIEW_MAX_BODY_BYTES,
    });
    return await answer(() => subsystem.preview(scope, request, callerOf(context)));
  };

const applyHandler =
  (scope: CatalogInstallScope, subsystem: CatalogInstallSubsystem): Handler =>
  async context => {
    ownerOnly(context, 'install from a catalog');
    const request = await parseBody(context.request, CatalogInstallRequestSchema);
    const refusal = claimPasskey(context, scope);
    if (refusal !== undefined) return refusal;
    return await answer(() => subsystem.apply(scope, request, callerOf(context), context.governance));
  };

const removeHandler =
  (scope: CatalogInstallScope, subsystem: CatalogInstallSubsystem): Handler =>
  async context => {
    ownerOnly(context, 'remove a catalog install');
    const id = installId(context);
    return await answer(() => subsystem.remove(scope, id, context.governance, freshStepUpOf(context)));
  };

/** This subsystem's route table. Every path is a literal, so the route-agreement pass can hold each one to a client. */
export function catalogInstallRoutes(subsystem: CatalogInstallSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/catalog-installs/project/preview',
      minimum: 'operator',
      capability: FILESYSTEM_USE,
      noStore: true,
      handle: previewHandler('project', subsystem),
    },
    {
      method: 'POST',
      path: '/v1/catalog-installs/runtime/preview',
      minimum: 'operator',
      capability: FLEET_USE,
      noStore: true,
      handle: previewHandler('runtime', subsystem),
    },
    {
      method: 'POST',
      path: '/v1/catalog-installs/project',
      minimum: 'operator',
      capability: FILESYSTEM_CONFIGURE,
      noStore: true,
      handle: applyHandler('project', subsystem),
    },
    {
      method: 'POST',
      path: '/v1/catalog-installs/runtime',
      minimum: 'operator',
      capability: FLEET_CONFIGURE,
      noStore: true,
      handle: applyHandler('runtime', subsystem),
    },
    {
      method: 'GET',
      path: '/v1/catalog-installs',
      minimum: 'operator',
      capability: FLEET_USE,
      noStore: true,
      handle: async () => await answer(() => subsystem.list()),
    },
    {
      method: 'DELETE',
      path: '/v1/catalog-installs/project/:installId',
      minimum: 'operator',
      capability: FILESYSTEM_CONFIGURE,
      noStore: true,
      handle: removeHandler('project', subsystem),
    },
    {
      method: 'DELETE',
      path: '/v1/catalog-installs/runtime/:installId',
      minimum: 'operator',
      capability: FLEET_CONFIGURE,
      noStore: true,
      handle: removeHandler('runtime', subsystem),
    },
  ];
}
