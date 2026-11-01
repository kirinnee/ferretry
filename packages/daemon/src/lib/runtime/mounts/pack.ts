import {
  PackCleanUpJobResultSchema,
  PackCleanUpRequestSchema,
  PackCleanUpStartSchema,
  PackInventorySchema,
  PackNewOutcomeSchema,
  PackNewRequestSchema,
  PackRecommendationSchema,
  PackRecommendRequestSchema,
  PackRoutingAcceptRequestSchema,
  PackRoutingWriteResultSchema,
  PackViewSchema,
  type SessionPackPatchResult,
  SessionPackPatchSchema,
  type SessionResult,
  SessionResultSchema,
  type SessionView,
} from '@ferretry/protocol';
import { isAgentCaller } from '../../api/agent-caller.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { lineageOf } from '../../api/lineage.ts';
import { type StateHomeReach, stateHomeLaunchRefusal } from '../../api/state-homes.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { CleanUpService, GuideFileService } from '../../pack/cleanup/index.ts';
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
 * CLEAN UP, the routing prompt's generator (docs/pack-mode.md § Clean up): the inventory is a `fleet.use`
 * read; starting a clean-up ferret, accepting and undoing are a PERSON's acts — a ferret's own credential is
 * refused, so no agent spends a model run or rewrites the prompt unasked — and the writes are
 * `fleet.configure`, as any edit of `models-guide.yaml` through the configuration routes is.
 */
export interface PackSubsystem {
  readonly service: Pick<PackService, 'view' | 'recommend' | 'newChild' | 'inventory'>;
  /** Clean up and the writes of what it rewrites. */
  readonly routing: {
    readonly cleanUp: Pick<CleanUpService, 'status' | 'start' | 'job'>;
    readonly file: Pick<GuideFileService, 'undoable' | 'accept' | 'undo'>;
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
  if (isAgentCaller(context)) throw new ApiError(403, `only a person can ${act}; ask the owner`, 'forbidden');
}

async function view(subsystem: PackSubsystem): Promise<ApiResponse> {
  const [base, undo, cleanUp] = await Promise.all([
    subsystem.service.view(),
    subsystem.routing.file.undoable(),
    subsystem.routing.cleanUp.status(),
  ]);
  return jsonResponse(PackViewSchema.parse({ ...base, ...(undo === undefined ? {} : { undo }), cleanUp }));
}

async function cleanUp(subsystem: PackSubsystem, context: RouteContext): Promise<ApiResponse> {
  personOnly(context, 'start a routing prompt clean-up');
  const request = await parseBody(context.request, PackCleanUpRequestSchema);
  const started = await subsystem.routing.cleanUp.start(request);
  return jsonResponse(PackCleanUpStartSchema.parse(started), started.outcome === 'started' ? 201 : 200);
}

async function job(subsystem: PackSubsystem, context: RouteContext): Promise<ApiResponse> {
  const id = decodeParameter(context.params.get('jobId') ?? '');
  const found =
    id === undefined || id === '' ? undefined : await subsystem.routing.cleanUp.job(id).catch(() => undefined);
  if (found === undefined) throw new ApiError(404, 'no such routing prompt clean-up', 'not-found');
  return jsonResponse(PackCleanUpJobResultSchema.parse(found));
}

async function write(context: RouteContext, act: string, run: () => Promise<unknown>): Promise<ApiResponse> {
  personOnly(context, act);
  return jsonResponse(PackRoutingWriteResultSchema.parse(await run()));
}

function sessionParameter(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

async function recommend(subsystem: PackSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, PackRecommendRequestSchema);
  return jsonResponse(PackRecommendationSchema.parse(await subsystem.service.recommend(request)));
}

async function newChild(
  subsystem: PackSubsystem,
  stateHomes: StateHomeReach | undefined,
  context: RouteContext,
): Promise<ApiResponse> {
  const request = lineageOf(context, await parseBody(context.request, PackNewRequestSchema));
  if (request.cwd !== undefined && context.presentation !== undefined && !context.presentation.loopback)
    throw new ApiError(
      403,
      "a sub-ferret's folder may be chosen only at this machine; leave --cwd out to run it in its parent's folder",
      'not-granted',
    );
  // Never in the state home, the same rule a ferret's `POST /v1/sessions` start meets.
  await stateHomeLaunchRefusal(context, stateHomes, request.cwd);
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
export function packRoutes(
  subsystem: PackSubsystem,
  /** The daemon's own directories: a ferret names no `--cwd` inside them. Absent: it names none at all. */
  stateHomes?: StateHomeReach,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/pack',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async () => await view(subsystem),
    },
    {
      method: 'GET',
      path: '/v1/pack/inventory',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async () => jsonResponse(PackInventorySchema.parse(await subsystem.service.inventory())),
    },
    {
      method: 'POST',
      path: '/v1/pack/routing/clean-up',
      minimum: 'operator',
      caller: 'person',
      capability: USE,
      noStore: true,
      handle: async context => await cleanUp(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/pack/routing/jobs/:jobId',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async context => await job(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/pack/routing/accept',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context =>
        await write(context, 'accept a cleaned-up routing prompt', async () =>
          subsystem.routing.file.accept(await parseBody(context.request, PackRoutingAcceptRequestSchema)),
        ),
    },
    {
      method: 'POST',
      path: '/v1/pack/routing/undo',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context =>
        await write(context, 'undo an accepted routing prompt', async () => subsystem.routing.file.undo()),
    },
    {
      method: 'POST',
      path: '/v1/pack/recommend',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async context => await recommend(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/pack/new',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await newChild(subsystem, stateHomes, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/result',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await result(subsystem, context),
    },
    {
      method: 'PATCH',
      path: '/v1/sessions/:sessionId/pack',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => await setSwitch(subsystem, context),
    },
  ];
}
