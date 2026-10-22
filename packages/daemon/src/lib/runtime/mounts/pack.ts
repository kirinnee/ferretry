import {
  PackGuideAcceptRequestSchema,
  PackGuideDescribeRequestSchema,
  PackGuideJobResultSchema,
  PackGuideSuggestRequestSchema,
  PackGuideSuggestStartSchema,
  PackGuideWriteResultSchema,
  PackInventorySchema,
  PackNewOutcomeSchema,
  PackNewRequestSchema,
  PackRecommendationSchema,
  PackRecommendRequestSchema,
  PackViewSchema,
  type SessionPackPatchResult,
  SessionPackPatchSchema,
  type SessionResult,
  SessionResultSchema,
  type SessionView,
} from '@ferretry/protocol';
import { isHumanAdminActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { GuideBuilderService, GuideFileService } from '../../pack/builder/index.ts';
import { GuideModelUnknownError } from '../../pack/builder/index.ts';
import type { PackService } from '../../pack/service.ts';
import { type PackSwitchOutcome, SessionPackError } from '../../session/pack/service.ts';

/**
 * PACK MODE (docs/pack-mode.md): the settings page's view, a recommendation, a sub-ferret start, a
 * finished ferret's result, and one ferret's own switch.
 *
 * `fleet.use` for the two reads of the fleet, as `/v1/fleet/runtimes` is. A start is the session
 * start's own posture — `operator`, no capability — and the session start route's limits apply to it
 * inside the daemon. A folder chosen by a caller off this machine would be terminal access, so only a
 * caller AT the machine may name one; anyone else's sub-ferret runs in its parent's folder.
 *
 * The models-guide GENERATOR (docs/pack-mode.md § Suggesting a guide): the inventory is a `fleet.use` read;
 * starting a builder ferret, accepting, undoing and describing are a PERSON's acts — a ferret's own
 * credential is refused, so no agent spends a model run or rewrites the guide unasked — and the writes are
 * `fleet.configure`, as any edit of the guide through the configuration routes is.
 */
export interface PackSubsystem {
  readonly service: Pick<PackService, 'view' | 'recommend' | 'newChild' | 'inventory'>;
  /** The guide builder and the writes of what it drafts. */
  readonly guide: {
    readonly builder: Pick<GuideBuilderService, 'status' | 'start' | 'job'>;
    readonly file: Pick<GuideFileService, 'undoable' | 'accept' | 'undo' | 'describe'>;
  };
  /** `undefined` when there is no such session. */
  result(sessionId: string): Promise<SessionResult | undefined>;
  setSwitch(
    sessionId: string,
    enabled: boolean,
  ): Promise<{ readonly view: SessionView; readonly outcome: PackSwitchOutcome }>;
}

const USE = { capability: 'fleet', axis: 'use' } as const;
const CONFIGURE = { capability: 'fleet', axis: 'configure' } as const;

/** Refuses a ferret's own credential: only a person (at the machine, or a paired device) does these. */
function personOnly(context: RouteContext, act: string): void {
  const agent =
    context.credential !== undefined && context.credential.tokenClass !== 'device' && !isHumanAdminActor(context.actor);
  if (agent) throw new ApiError(403, `only a person can ${act}; ask the owner`, 'forbidden');
}

async function view(subsystem: PackSubsystem): Promise<ApiResponse> {
  const [base, undo, builder] = await Promise.all([
    subsystem.service.view(),
    subsystem.guide.file.undoable(),
    subsystem.guide.builder.status(),
  ]);
  return jsonResponse(PackViewSchema.parse({ ...base, ...(undo === undefined ? {} : { undo }), builder }));
}

async function suggest(subsystem: PackSubsystem, context: RouteContext): Promise<ApiResponse> {
  personOnly(context, 'start the models guide builder');
  const request = await parseBody(context.request, PackGuideSuggestRequestSchema);
  const started = await subsystem.guide.builder.start(request);
  return jsonResponse(PackGuideSuggestStartSchema.parse(started), started.outcome === 'started' ? 201 : 200);
}

async function job(subsystem: PackSubsystem, context: RouteContext): Promise<ApiResponse> {
  const id = decodeParameter(context.params.get('jobId') ?? '');
  const found =
    id === undefined || id === '' ? undefined : await subsystem.guide.builder.job(id).catch(() => undefined);
  if (found === undefined) throw new ApiError(404, 'no such models guide builder run', 'not-found');
  return jsonResponse(PackGuideJobResultSchema.parse(found));
}

async function write(context: RouteContext, act: string, run: () => Promise<unknown>): Promise<ApiResponse> {
  personOnly(context, act);
  try {
    return jsonResponse(PackGuideWriteResultSchema.parse(await run()));
  } catch (error) {
    if (error instanceof GuideModelUnknownError) throw new ApiError(404, error.message, 'not-found');
    throw error;
  }
}

function sessionParameter(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

async function recommend(subsystem: PackSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, PackRecommendRequestSchema);
  const recommendation = await subsystem.service.recommend(request);
  if (recommendation === undefined)
    throw new ApiError(409, 'the models guide names no use case; add one in Settings › Pack mode', 'no_candidate');
  return jsonResponse(PackRecommendationSchema.parse(recommendation));
}

async function newChild(subsystem: PackSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, PackNewRequestSchema);
  if (request.cwd !== undefined && context.presentation !== undefined && !context.presentation.loopback)
    throw new ApiError(
      403,
      "a sub-ferret's folder may be chosen only at this machine; leave --cwd out to run it in its parent's folder",
      'not-granted',
    );
  const outcome = await subsystem.service.newChild(request);
  return jsonResponse(PackNewOutcomeSchema.parse(outcome), outcome.outcome === 'started' ? 201 : 200);
}

async function result(subsystem: PackSubsystem, context: RouteContext): Promise<ApiResponse> {
  const id = sessionParameter(context);
  const found = await subsystem.result(id);
  if (found === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
  return jsonResponse(SessionResultSchema.parse(found));
}

async function setSwitch(subsystem: PackSubsystem, context: RouteContext): Promise<ApiResponse> {
  const id = sessionParameter(context);
  const request = await parseBody(context.request, SessionPackPatchSchema);
  const { view, outcome } = await subsystem.setSwitch(id, request.enabled).catch((error: unknown) => {
    if (error instanceof SessionPackError) throw new ApiError(404, error.message, 'not-found');
    throw error;
  });
  return jsonResponse({ view, ...outcome } satisfies SessionPackPatchResult);
}

/** `noStore` throughout: every answer is decided on live fleet facts or a live session. */
export function packRoutes(subsystem: PackSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/pack',
      minimum: 'operator',
      capability: USE,
      noStore: true,
      handle: async () => await view(subsystem),
    },
    {
      method: 'GET',
      path: '/v1/pack/inventory',
      minimum: 'operator',
      capability: USE,
      noStore: true,
      handle: async () => jsonResponse(PackInventorySchema.parse(await subsystem.service.inventory())),
    },
    {
      method: 'POST',
      path: '/v1/pack/guide/suggest',
      minimum: 'operator',
      capability: USE,
      noStore: true,
      handle: async context => await suggest(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/pack/guide/jobs/:jobId',
      minimum: 'operator',
      capability: USE,
      noStore: true,
      handle: async context => await job(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/pack/guide/accept',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async context =>
        await write(context, 'accept a models guide', async () =>
          subsystem.guide.file.accept(
            await parseBody(context.request, PackGuideAcceptRequestSchema, { maxBytes: 512 * 1_024 }),
          ),
        ),
    },
    {
      method: 'POST',
      path: '/v1/pack/guide/undo',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async context =>
        await write(context, 'undo an accepted models guide', async () => subsystem.guide.file.undo()),
    },
    {
      method: 'POST',
      path: '/v1/pack/guide/describe',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async context =>
        await write(context, 'describe a model for the models guide', async () =>
          subsystem.guide.file.describe(await parseBody(context.request, PackGuideDescribeRequestSchema)),
        ),
    },
    {
      method: 'POST',
      path: '/v1/pack/recommend',
      minimum: 'operator',
      capability: USE,
      noStore: true,
      handle: async context => await recommend(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/pack/new',
      minimum: 'operator',
      noStore: true,
      handle: async context => await newChild(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/result',
      minimum: 'operator',
      noStore: true,
      handle: async context => await result(subsystem, context),
    },
    {
      method: 'PATCH',
      path: '/v1/sessions/:sessionId/pack',
      minimum: 'operator',
      noStore: true,
      handle: async context => await setSwitch(subsystem, context),
    },
  ];
}
