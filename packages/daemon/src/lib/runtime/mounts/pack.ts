import {
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
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
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
 */
export interface PackSubsystem {
  readonly service: Pick<PackService, 'view' | 'recommend' | 'newChild'>;
  /** `undefined` when there is no such session. */
  result(sessionId: string): Promise<SessionResult | undefined>;
  setSwitch(
    sessionId: string,
    enabled: boolean,
  ): Promise<{ readonly view: SessionView; readonly outcome: PackSwitchOutcome }>;
}

const USE = { capability: 'fleet', axis: 'use' } as const;

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
      handle: async () => jsonResponse(PackViewSchema.parse(await subsystem.service.view())),
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
