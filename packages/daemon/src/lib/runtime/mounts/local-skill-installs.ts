/**
 * Copying a skill from another account or project on this machine: `/v1/skill-installs/local`. The domain is
 * `local-skill-installs/service.ts`; the wire is `@ferretry/protocol` local-skill-install.
 *
 * ONE ROUTE PER SCOPE, because a route declares exactly one capability and the scopes are governed by
 * different ones: a project is the person's repository (`filesystem`), a runtime is the fleet (`fleet`).
 * A preview is a read with a body (`use`); an apply or a removal changes something (`configure`).
 *
 * PERSON-ONLY, EVERY ROUTE. A preview shows another account's files in full, and an apply puts
 * instructions a ferret will follow (and scripts it may run) where it will find them, so a ferret that could
 * do either could hand itself a skill from an account with more access than its own. The route table says
 * `caller: 'person'` and each handler refuses a ferret before it reads a body. A governed device applies
 * only with a passkey proved for the `catalog-install` act — the same act as a catalog install, because it
 * is the same decision (adding instructions to run), and a proof is claimed atomically at admission, so one
 * confirmation buys one copy. The machine's own `fy` is ungoverned and its CLI asks y/N instead. Removing
 * never asks for a passkey: taking something away is the safe direction.
 *
 * A PREVIEW BELONGS TO ITS CALLER, as a catalog install's does.
 *
 * The deeper `preview` paths are registered before the scope paths so no pattern shadows another.
 */
import {
  LocalSkillInstallIdSchema,
  type LocalSkillInstalled,
  LocalSkillInstallRequestSchema,
  type LocalSkillInstallList,
  type LocalSkillPreview,
  LocalSkillPreviewRequestSchema,
  type LocalSkillRefusal,
  type LocalSkillRemoved,
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
import { FleetCatalogRefusal, type FreshStepUpContext } from '../../fleet/catalog-service.ts';
import { LocalSkillRefusalError } from '../../local-skill-installs/ports.ts';
import type { LocalSkillCaller } from '../../local-skill-installs/service.ts';
import { LocalSkillInstallStateError } from '../../local-skill-installs/store.ts';
import type { LocalSkillPreviewRequest } from '@ferretry/protocol';

/** The four acts, from the parsed request to the answer the caller sees. */
export interface LocalSkillInstallSubsystem {
  list(): Promise<LocalSkillInstallList>;
  preview(
    scope: CatalogInstallScope,
    request: LocalSkillPreviewRequest,
    caller: LocalSkillCaller,
  ): Promise<LocalSkillPreview>;
  apply(
    scope: CatalogInstallScope,
    previewId: string,
    caller: LocalSkillCaller,
    governance: CallerGovernance | undefined,
  ): Promise<LocalSkillInstalled>;
  remove(
    scope: CatalogInstallScope,
    installId: string,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<LocalSkillRemoved>;
}

const FILESYSTEM_USE: CapabilityDemand = { capability: 'filesystem', axis: 'use' };
const FILESYSTEM_CONFIGURE: CapabilityDemand = { capability: 'filesystem', axis: 'configure' };
const FLEET_USE: CapabilityDemand = { capability: 'fleet', axis: 'use' };
const FLEET_CONFIGURE: CapabilityDemand = { capability: 'fleet', axis: 'configure' };

const demandFor = (scope: CatalogInstallScope): CapabilityDemand =>
  scope === 'project' ? FILESYSTEM_CONFIGURE : FLEET_CONFIGURE;

/** Each refusal's HTTP status. A wrong request is 4xx, a thing in the way is 409, and a missing one is 404. */
const REFUSAL_STATUS: Readonly<Record<LocalSkillRefusal, number>> = {
  local_skill_source_unknown: 404,
  local_skill_source_invalid: 422,
  local_skill_target_unknown: 404,
  local_skill_preview_unknown: 404,
  local_skill_preview_expired: 410,
  local_skill_conflict: 409,
  local_skill_install_unknown: 404,
};

/** Restates a refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof LocalSkillRefusalError)
    throw new ApiError(REFUSAL_STATUS[error.code], error.message, error.code);
  if (error instanceof FleetCatalogRefusal)
    throw new ApiError(error.code === 'fleet_change_unknown' ? 404 : 409, error.message, error.code);
  if (error instanceof LocalSkillInstallStateError)
    throw new ApiError(500, error.message, 'local_skill_installs_unreadable');
  throw error;
}

async function answer(work: () => Promise<unknown>): Promise<ApiResponse> {
  return jsonResponse(await work().catch(refuse));
}

function ownerOnly(context: RouteContext, act: string): void {
  if (isAgentCaller(context)) throw new ApiError(403, `a ferret cannot ${act}; the owner does`, 'forbidden');
}

/** Who is asking, as a preview and its apply must agree: a paired device by its id, and the host's own shell as another. */
function callerOf(context: RouteContext): LocalSkillCaller {
  const credential = context.credential;
  return { id: credential?.tokenClass === 'device' ? `device:${credential.deviceId}` : 'host' };
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
      error: 'copying a skill needs a passkey confirmation for it, from this device',
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
  const parsed = LocalSkillInstallIdSchema.safeParse(decodeParameter(context.params.get('installId') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the install id in the path is not usable', 'invalid_install_id');
  return parsed.data;
}

type Handler = ApiRoute['handle'];

const previewHandler =
  (scope: CatalogInstallScope, subsystem: LocalSkillInstallSubsystem): Handler =>
  async context => {
    ownerOnly(context, "copy another account's skill");
    const request = await parseBody(context.request, LocalSkillPreviewRequestSchema);
    return await answer(() => subsystem.preview(scope, request, callerOf(context)));
  };

const applyHandler =
  (scope: CatalogInstallScope, subsystem: LocalSkillInstallSubsystem): Handler =>
  async context => {
    ownerOnly(context, 'copy a skill');
    const request = await parseBody(context.request, LocalSkillInstallRequestSchema);
    const refusal = claimPasskey(context, scope);
    if (refusal !== undefined) return refusal;
    return await answer(() => subsystem.apply(scope, request.previewId, callerOf(context), context.governance));
  };

const removeHandler =
  (scope: CatalogInstallScope, subsystem: LocalSkillInstallSubsystem): Handler =>
  async context => {
    ownerOnly(context, 'remove a copied skill');
    const id = installId(context);
    return await answer(() => subsystem.remove(scope, id, context.governance, freshStepUpOf(context)));
  };

/** This subsystem's route table. Every path is a literal, so the route-agreement pass can hold each one to a client. */
export function localSkillInstallRoutes(subsystem: LocalSkillInstallSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/skill-installs/local/project/preview',
      minimum: 'operator',
      caller: 'person',
      capability: FILESYSTEM_USE,
      noStore: true,
      handle: previewHandler('project', subsystem),
    },
    {
      method: 'POST',
      path: '/v1/skill-installs/local/runtime/preview',
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_USE,
      noStore: true,
      handle: previewHandler('runtime', subsystem),
    },
    {
      method: 'POST',
      path: '/v1/skill-installs/local/project',
      minimum: 'operator',
      caller: 'person',
      capability: FILESYSTEM_CONFIGURE,
      noStore: true,
      handle: applyHandler('project', subsystem),
    },
    {
      method: 'POST',
      path: '/v1/skill-installs/local/runtime',
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_CONFIGURE,
      noStore: true,
      handle: applyHandler('runtime', subsystem),
    },
    {
      method: 'GET',
      path: '/v1/skill-installs/local',
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_USE,
      noStore: true,
      handle: async context => {
        ownerOnly(context, 'list copied skills');
        return await answer(() => subsystem.list());
      },
    },
    {
      method: 'DELETE',
      path: '/v1/skill-installs/local/project/:installId',
      minimum: 'operator',
      caller: 'person',
      capability: FILESYSTEM_CONFIGURE,
      noStore: true,
      handle: removeHandler('project', subsystem),
    },
    {
      method: 'DELETE',
      path: '/v1/skill-installs/local/runtime/:installId',
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_CONFIGURE,
      noStore: true,
      handle: removeHandler('runtime', subsystem),
    },
  ];
}
