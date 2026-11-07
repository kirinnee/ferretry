import {
  decodeParameter,
  errorResponse,
  type ApiRequest,
  type ApiResponse,
  jsonResponse,
  type RouteParameters,
} from '@ferretry/kernel/contract';
import {
  PerformanceProfileRequestSchema,
  type PerformanceProfileView,
  PerformanceProfileViewSchema,
} from '../../contract/index.ts';
import { parseBody } from '../lib/body.ts';

/** Starts a profile and reads it back by id. */
export interface PerformanceSubsystem {
  start(seconds: number): PerformanceProfileView;
  view(id: string): PerformanceProfileView | undefined;
}

/**
 * `POST /v1/diagnostics/profile` starts a window onto the daemon's own counters; `GET /v1/diagnostics/profile/:id` reads it,
 * `running` until the window closes, then the report. Started-then-read rather than one long request, so a dropped relay
 * connection mid-window costs a retry of the read, not the window. The report names no content and no secret.
 */
export const performanceHandlers = (subsystem: PerformanceSubsystem) => ({
  start: async (request: ApiRequest): Promise<ApiResponse> => {
    const { seconds } = await parseBody(request, PerformanceProfileRequestSchema);
    return jsonResponse(PerformanceProfileViewSchema.parse(subsystem.start(seconds)), 202);
  },
  read: async (params: RouteParameters): Promise<ApiResponse> => {
    const id = decodeParameter(params.get('id') ?? '');
    const view = id === undefined ? undefined : subsystem.view(id);
    if (view === undefined) return errorResponse(404, 'no such profile on this daemon', 'profile_not_found');
    return jsonResponse(PerformanceProfileViewSchema.parse(view));
  },
});
