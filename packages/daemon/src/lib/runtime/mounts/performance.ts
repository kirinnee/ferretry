import {
  PerformanceProfileRequestSchema,
  type PerformanceProfileView,
  PerformanceProfileViewSchema,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { decodeParameter } from '../../api/http.ts';
import { errorResponse, jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';

/** Starts a profile and reads it back by id. */
export interface PerformanceSubsystem {
  start(seconds: number): PerformanceProfileView;
  view(id: string): PerformanceProfileView | undefined;
}

/**
 * `POST /v1/diagnostics/profile` starts a window onto the daemon's own counters, and
 * `GET /v1/diagnostics/profile/:id` reads it — `running` until the window closes, then the report.
 *
 * OPERATOR, like the doctor beside it: the report names no content and no secret, but it describes the
 * machine — which programs it runs, how its fleet is shaped — and that is for its owner's devices.
 * Started-then-read rather than one long request, so a dropped relay connection mid-window costs a
 * retry of the read, not the window.
 */
export function performanceRoutes(subsystem: PerformanceSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/diagnostics/profile',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async ({ request }) => {
        const { seconds } = await parseBody(request, PerformanceProfileRequestSchema);
        return jsonResponse(PerformanceProfileViewSchema.parse(subsystem.start(seconds)), 202);
      },
    },
    {
      method: 'GET',
      path: '/v1/diagnostics/profile/:id',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async ({ params }) => {
        const id = decodeParameter(params.get('id') ?? '');
        const view = id === undefined ? undefined : subsystem.view(id);
        if (view === undefined) return errorResponse(404, 'no such profile on this daemon', 'profile_not_found');
        return jsonResponse(PerformanceProfileViewSchema.parse(view));
      },
    },
  ];
}
