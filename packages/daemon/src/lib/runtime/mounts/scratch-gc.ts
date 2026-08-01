import {
  ScratchPlanListSchema,
  ScratchSweepRequestSchema,
  type ScratchPlanView,
  type ScratchSweepView,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiRequest, ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';

/** The scratch collector surface the HTTP routes require. */
export interface ScratchGcSubsystem {
  plan(limit: number): Promise<readonly ScratchPlanView[]>;
  sweep(force: boolean): Promise<ScratchSweepView>;
}

function requestedLimit(request: ApiRequest): number {
  for (const [name] of request.query) {
    if (name !== 'limit') throw new ApiError(400, `unknown gc parameter ${name}`, 'unknown_parameter');
  }
  const raw = request.query.get('limit')?.[0];
  if (raw === undefined) return 20;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new ApiError(400, 'gc limit must be a positive whole number', 'invalid_limit');
  return limit;
}

async function plan(subsystem: ScratchGcSubsystem, request: ApiRequest): Promise<ApiResponse> {
  const response = ScratchPlanListSchema.parse(await subsystem.plan(requestedLimit(request)));
  return jsonResponse(response);
}

async function sweep(subsystem: ScratchGcSubsystem, request: ApiRequest): Promise<ApiResponse> {
  const body = await parseBody(request, ScratchSweepRequestSchema);
  return jsonResponse(await subsystem.sweep(body.force));
}

/**
 * An explicit operator-controlled collector. The monitor/warden runtime may
 * later schedule the same `sweep` method, but this surface is useful and safe
 * on its own: the plan explains exactly what a forced sweep can reclaim.
 */
export function scratchGcRoutes(subsystem: ScratchGcSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/gc',
      scope: 'admin',
      noStore: true,
      handle: async context => await plan(subsystem, context.request),
    },
    {
      method: 'POST',
      path: '/v1/gc',
      scope: 'admin',
      noStore: true,
      handle: async context => await sweep(subsystem, context.request),
    },
  ];
}
