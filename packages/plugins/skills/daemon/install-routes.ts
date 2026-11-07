import {
  ApiError,
  type CallContext,
  decodeParameter,
  jsonResponse,
  type PlainApiResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import {
  cap,
  type CapabilityName,
  isFerretCall,
  OWNER_ONLY_CODE,
  ownerOnlyWords,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/core-gate/contract';
import {
  type LocalSkillInstallList,
  LocalSkillInstallIdSchema,
  type LocalSkillInstalled,
  LocalSkillInstallRequestSchema,
  type LocalSkillPreview,
  type LocalSkillPreviewRequest,
  LocalSkillPreviewRequestSchema,
  type LocalSkillRefusal,
  type LocalSkillRemoved,
  type SkillInstallScope,
} from '../contract/index.ts';
import { parseBody } from './lib/body.ts';
import { LocalSkillRefusalError, SkillFolderChanged, SkillFolderRefused } from './lib/installs/ports.ts';
import type { LocalSkillCaller } from './lib/installs/service.ts';
import { LocalSkillInstallStateError } from './lib/installs/store.ts';

/** The four acts, from the parsed request to the answer the caller sees. */
export interface LocalSkillInstallSubsystem {
  list(): Promise<LocalSkillInstallList>;
  preview(
    scope: SkillInstallScope,
    request: LocalSkillPreviewRequest,
    caller: LocalSkillCaller,
  ): Promise<LocalSkillPreview>;
  apply(scope: SkillInstallScope, previewId: string, caller: LocalSkillCaller): Promise<LocalSkillInstalled>;
  remove(scope: SkillInstallScope, installId: string): Promise<LocalSkillRemoved>;
}

const demandFor = (scope: SkillInstallScope): { capability: CapabilityName; axis: 'configure' } =>
  scope === 'project' ? { capability: 'filesystem', axis: 'configure' } : { capability: 'fleet', axis: 'configure' };

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
  if (error instanceof SkillFolderRefused || error instanceof SkillFolderChanged)
    throw new ApiError(409, error.message, 'local_skill_conflict');
  if (error instanceof LocalSkillInstallStateError)
    throw new ApiError(500, error.message, 'local_skill_installs_unreadable');
  throw error;
}

async function answer(work: () => Promise<unknown>): Promise<PlainApiResponse> {
  return jsonResponse(await work().catch(refuse));
}

/** G174: a ferret is refused every one of these, before a body is read. */
function ownerOnly(call: CallContext, act: string): void {
  if (isFerretCall(call)) throw new ApiError(403, ownerOnlyWords(act), OWNER_ONLY_CODE);
}

/** Who is asking, as a preview and its apply must agree: a paired device by its id, and the host's own shell as another. */
function callerOf(call: CallContext): LocalSkillCaller {
  const credential = call.credential;
  return { id: credential?.tokenClass === 'device' ? `device:${credential.principal.holder}` : 'host' };
}

/**
 * Claims the passkey proof for the `catalog-install` act, atomically, and answers the refusal when a governed
 * caller holds none (or someone else already spent it). `undefined` means it may go on.
 */
function claimPasskey(call: CallContext, scope: SkillInstallScope): PlainApiResponse | undefined {
  if (call.governance?.governed !== true || call.claimFreshStepUp?.(STEP_UP_ACTS.catalogInstall) === true)
    return undefined;
  const body: StepUpRequiredBody = {
    error: 'copying a skill needs a passkey confirmation for it, from this device',
    code: STEP_UP_REQUIRED_CODE,
    demand: { ...demandFor(scope), act: 'catalog-install' },
  };
  return jsonResponse(body, 403);
}

function installId(call: CallContext): string {
  const parsed = LocalSkillInstallIdSchema.safeParse(decodeParameter(call.params.get('installId') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the install id in the path is not usable', 'invalid_install_id');
  return parsed.data;
}

const previewHandler =
  (scope: SkillInstallScope, subsystem: LocalSkillInstallSubsystem): RouteHandler =>
  async call => {
    ownerOnly(call, "copies another account's skill");
    const request = await parseBody(call.request, LocalSkillPreviewRequestSchema);
    return await answer(() => subsystem.preview(scope, request, callerOf(call)));
  };

const applyHandler =
  (scope: SkillInstallScope, subsystem: LocalSkillInstallSubsystem): RouteHandler =>
  async call => {
    ownerOnly(call, 'copies a skill');
    const request = await parseBody(call.request, LocalSkillInstallRequestSchema);
    const refusal = claimPasskey(call, scope);
    if (refusal !== undefined) return refusal;
    return await answer(() => subsystem.apply(scope, request.previewId, callerOf(call)));
  };

const removeHandler =
  (scope: SkillInstallScope, subsystem: LocalSkillInstallSubsystem): RouteHandler =>
  async call => {
    ownerOnly(call, 'removes a copied skill');
    const id = installId(call);
    return await answer(() => subsystem.remove(scope, id));
  };

/** This subsystem's route handlers, keyed as the manifest declares them. */
export function installRoutes(subsystem: LocalSkillInstallSubsystem): {
  readonly 'POST /v1/skills/installs/local/project/preview': RouteHandler;
  readonly 'POST /v1/skills/installs/local/runtime/preview': RouteHandler;
  readonly 'POST /v1/skills/installs/local/project': RouteHandler;
  readonly 'POST /v1/skills/installs/local/runtime': RouteHandler;
  readonly 'GET /v1/skills/installs/local': RouteHandler;
  readonly 'DELETE /v1/skills/installs/local/project/:installId': RouteHandler;
  readonly 'DELETE /v1/skills/installs/local/runtime/:installId': RouteHandler;
} {
  return {
    'POST /v1/skills/installs/local/project/preview': previewHandler('project', subsystem),
    'POST /v1/skills/installs/local/runtime/preview': previewHandler('runtime', subsystem),
    'POST /v1/skills/installs/local/project': applyHandler('project', subsystem),
    'POST /v1/skills/installs/local/runtime': applyHandler('runtime', subsystem),
    'GET /v1/skills/installs/local': async call => {
      ownerOnly(call, 'lists copied skills');
      // The list answers the project rows only to a caller whose `filesystem.use` is allowed.
      const mayReadProjects = call.governance?.decide(cap('filesystem', 'use')).allowed !== false;
      return await answer(async () => {
        const listed = await subsystem.list();
        return mayReadProjects
          ? listed
          : { ...listed, installs: listed.installs.filter(install => install.target.scope !== 'project') };
      });
    },
    'DELETE /v1/skills/installs/local/project/:installId': removeHandler('project', subsystem),
    'DELETE /v1/skills/installs/local/runtime/:installId': removeHandler('runtime', subsystem),
  };
}
