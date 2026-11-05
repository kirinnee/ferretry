/**
 * Copying an MCP server from another account or project on this machine: `/v1/mcp-installs/local`. The domain is
 * `local-mcp-installs/service.ts`; the wire is `@ferretry/protocol` local-mcp-install. It is
 * `local-skill-installs.ts`'s twin and keeps its conditions:
 *
 * ONE ROUTE PER SCOPE, because a route declares exactly one capability. An apply or a removal is governed by what
 * it changes: a project is the person's repository (`filesystem.configure`), a runtime is the fleet
 * (`fleet.configure`). BOTH PREVIEWS ARE `filesystem.use`, whatever the target: the act that matters is reading
 * another account's configuration, and a device with the filesystem switched off must not read it by naming a
 * runtime. The list answers the project rows only to a caller whose `filesystem.use` is allowed.
 *
 * PERSON-ONLY, EVERY ROUTE. A server definition is a program a ferret will be started with, so a ferret that
 * could copy one could hand itself a tool from an account with more access than its own. The route table says
 * `caller: 'person'` and each handler refuses a ferret before it reads a body. A governed device applies only with
 * a passkey proved for the `catalog-install` act — the same decision as a catalog install, claimed atomically
 * at admission. Removing never asks for one.
 *
 * NO SECRET VALUE CROSSES THIS WIRE. A preview lists placeholders (and, only to a caller who may list secret
 * names, whether each is held); an apply carries the person's bindings, which are secret NAMES.
 *
 * A PREVIEW BELONGS TO ITS CALLER. The deeper `preview` paths are registered before the scope paths.
 */
import {
  type CatalogInstallScope,
  type LocalMcpInstalled,
  LocalMcpInstallIdSchema,
  type LocalMcpInstallList,
  LocalMcpInstallRequestSchema,
  type LocalMcpPreview,
  type LocalMcpPreviewRequest,
  LocalMcpPreviewRequestSchema,
  type LocalMcpRefusal,
  type LocalMcpRemoved,
  type CatalogSecretBindings,
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
import { FleetCatalogRefusal, type FreshStepUpContext } from '../../fleet/catalog-service.ts';
import { LocalMcpRefusalError } from '../../local-mcp-installs/ports.ts';
import type { LocalMcpCaller } from '../../local-mcp-installs/service.ts';
import { LocalMcpInstallStateError } from '../../local-mcp-installs/store.ts';

/** The four acts, from the parsed request to the answer the caller sees. */
export interface LocalMcpInstallSubsystem {
  list(): Promise<LocalMcpInstallList>;
  preview(
    scope: CatalogInstallScope,
    request: LocalMcpPreviewRequest,
    caller: LocalMcpCaller,
  ): Promise<LocalMcpPreview>;
  apply(
    scope: CatalogInstallScope,
    previewId: string,
    bindings: CatalogSecretBindings,
    caller: LocalMcpCaller,
    governance: CallerGovernance | undefined,
  ): Promise<LocalMcpInstalled>;
  remove(
    scope: CatalogInstallScope,
    installId: string,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<LocalMcpRemoved>;
}

const FILESYSTEM_USE: CapabilityDemand = { capability: 'filesystem', axis: 'use' };
const FILESYSTEM_CONFIGURE: CapabilityDemand = { capability: 'filesystem', axis: 'configure' };
const FLEET_USE: CapabilityDemand = { capability: 'fleet', axis: 'use' };
const FLEET_CONFIGURE: CapabilityDemand = { capability: 'fleet', axis: 'configure' };
const SECRETS_USE: CapabilityDemand = { capability: 'secrets', axis: 'use' };

const demandFor = (scope: CatalogInstallScope): CapabilityDemand =>
  scope === 'project' ? FILESYSTEM_CONFIGURE : FLEET_CONFIGURE;

/** Each refusal's HTTP status. A wrong request is 4xx, a thing in the way is 409, and a missing one is 404. */
const REFUSAL_STATUS: Readonly<Record<LocalMcpRefusal, number>> = {
  local_mcp_source_unknown: 404,
  local_mcp_source_invalid: 422,
  local_mcp_target_unknown: 404,
  local_mcp_bindings_invalid: 422,
  local_mcp_preview_unknown: 404,
  local_mcp_preview_expired: 410,
  local_mcp_conflict: 409,
  local_mcp_install_unknown: 404,
};

/** Restates a refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof LocalMcpRefusalError) throw new ApiError(REFUSAL_STATUS[error.code], error.message, error.code);
  if (error instanceof FleetCatalogRefusal)
    throw new ApiError(error.code === 'fleet_change_unknown' ? 404 : 409, error.message, error.code);
  if (error instanceof LocalMcpInstallStateError)
    throw new ApiError(500, error.message, 'local_mcp_installs_unreadable');
  throw error;
}

async function answer(work: () => Promise<unknown>): Promise<ApiResponse> {
  return jsonResponse(await work().catch(refuse));
}

function ownerOnly(context: RouteContext, act: string): void {
  if (isAgentCaller(context)) throw new ApiError(403, `a ferret cannot ${act}; the owner does`, 'forbidden');
}

/** Who is asking, as a preview and its apply must agree, and whether they may be told which secrets are held. */
function callerOf(context: RouteContext): LocalMcpCaller {
  const credential = context.credential;
  return {
    id: credential?.tokenClass === 'device' ? `device:${credential.deviceId}` : 'host',
    mayListSecrets: context.governance?.decide(SECRETS_USE).allowed !== false,
  };
}

/**
 * Claims the passkey proof for the `catalog-install` act, atomically, and answers the refusal when a governed
 * caller holds none (or someone else already spent it). `undefined` means it may go on.
 */
function claimPasskey(context: RouteContext, scope: CatalogInstallScope): ApiResponse | undefined {
  if (context.governance?.governed !== true || context.claimFreshStepUp?.(STEP_UP_ACTS.catalogInstall) === true)
    return undefined;
  return jsonResponse(
    {
      error: 'copying an MCP server needs a passkey confirmation for it, from this device',
      code: STEP_UP_REQUIRED_CODE,
      demand: { ...demandFor(scope), act: STEP_UP_ACTS.catalogInstall },
    } satisfies StepUpRequiredBody,
    403,
  );
}

const freshStepUpOf = (context: RouteContext): FreshStepUpContext => ({
  presentation: context.presentation,
  spend: () => context.spendFreshStepUp?.(),
  agent: isAgentCaller(context),
});

function installId(context: RouteContext): string {
  const parsed = LocalMcpInstallIdSchema.safeParse(decodeParameter(context.params.get('installId') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the install id in the path is not usable', 'invalid_install_id');
  return parsed.data;
}

type Handler = ApiRoute['handle'];

const previewHandler =
  (scope: CatalogInstallScope, subsystem: LocalMcpInstallSubsystem): Handler =>
  async context => {
    ownerOnly(context, "copy another account's MCP server");
    const request = await parseBody(context.request, LocalMcpPreviewRequestSchema);
    return await answer(() => subsystem.preview(scope, request, callerOf(context)));
  };

const applyHandler =
  (scope: CatalogInstallScope, subsystem: LocalMcpInstallSubsystem): Handler =>
  async context => {
    ownerOnly(context, 'copy an MCP server');
    const request = await parseBody(context.request, LocalMcpInstallRequestSchema);
    const refusal = claimPasskey(context, scope);
    if (refusal !== undefined) return refusal;
    return await answer(() =>
      subsystem.apply(scope, request.previewId, request.secretBindings, callerOf(context), context.governance),
    );
  };

const removeHandler =
  (scope: CatalogInstallScope, subsystem: LocalMcpInstallSubsystem): Handler =>
  async context => {
    ownerOnly(context, 'remove a copied MCP server');
    const id = installId(context);
    return await answer(() => subsystem.remove(scope, id, context.governance, freshStepUpOf(context)));
  };

/** This subsystem's route table. Every path is a literal, so the route-agreement pass can hold each one to a client. */
export function localMcpInstallRoutes(subsystem: LocalMcpInstallSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/mcp-installs/local/project/preview',
      minimum: 'operator',
      caller: 'person',
      capability: FILESYSTEM_USE,
      noStore: true,
      handle: previewHandler('project', subsystem),
    },
    {
      method: 'POST',
      path: '/v1/mcp-installs/local/runtime/preview',
      minimum: 'operator',
      caller: 'person',
      capability: FILESYSTEM_USE,
      noStore: true,
      handle: previewHandler('runtime', subsystem),
    },
    {
      method: 'POST',
      path: '/v1/mcp-installs/local/project',
      minimum: 'operator',
      caller: 'person',
      capability: FILESYSTEM_CONFIGURE,
      noStore: true,
      handle: applyHandler('project', subsystem),
    },
    {
      method: 'POST',
      path: '/v1/mcp-installs/local/runtime',
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_CONFIGURE,
      noStore: true,
      handle: applyHandler('runtime', subsystem),
    },
    {
      method: 'GET',
      path: '/v1/mcp-installs/local',
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'list copied MCP servers');
        const mayReadProjects = context.governance?.decide(FILESYSTEM_USE).allowed !== false;
        return await answer(async () => {
          const listed = await subsystem.list();
          return mayReadProjects
            ? listed
            : { ...listed, installs: listed.installs.filter(install => install.target.scope !== 'project') };
        });
      },
    },
    {
      method: 'DELETE',
      path: '/v1/mcp-installs/local/project/:installId',
      minimum: 'operator',
      caller: 'person',
      capability: FILESYSTEM_CONFIGURE,
      noStore: true,
      handle: removeHandler('project', subsystem),
    },
    {
      method: 'DELETE',
      path: '/v1/mcp-installs/local/runtime/:installId',
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_CONFIGURE,
      noStore: true,
      handle: removeHandler('runtime', subsystem),
    },
  ];
}
