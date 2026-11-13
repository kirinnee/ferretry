import {
  type SessionCompactAt,
  type SessionCompactAtPatchResult,
  SessionCompactAtPatchSchema,
  type SessionView,
  type CompactAt,
} from '../../../seams/protocol.ts';
import { parseBody } from '../../../seams/api.ts';
import { ApiError } from '../../../seams/api.ts';
import { type ApiResponse, decodeParameter } from '../../../seams/api.ts';
import { jsonResponse } from '../../../seams/api.ts';
import type { MountRoute, RouteContext } from '../../../seams/api.ts';
import { type CompactAtOutcome, SessionCompactAtError } from '../../compact-at/lib/service.ts';

/**
 * Reading and setting where one ferret compacts its conversation: `GET` and `PATCH
 * /v1/ferrets/:ferretId/compact-at` (docs/compact-at.md). `PATCH` answers the changed `SessionView`, the value a
 * launch uses now, whether a restart is needed for it to take effect, and that said in words.
 *
 * `operator` scope and no capability, like the other per-ferret switches: it writes the session's own
 * configuration, grants nothing, and changes only what its harness is launched with.
 */
export interface SessionCompactAtSubsystem {
  get(sessionId: string): Promise<SessionCompactAt>;
  set(
    sessionId: string,
    wanted: CompactAt | 'inherit',
  ): Promise<{ readonly view: SessionView; readonly outcome: CompactAtOutcome }>;
}

function refuse(error: unknown): never {
  if (error instanceof SessionCompactAtError)
    throw new ApiError(
      error.reason === 'not-found' ? 404 : 400,
      error.message,
      error.reason === 'not-found' ? 'not-found' : 'invalid_compact_at',
    );
  throw error;
}

function sessionOf(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

async function patch(subsystem: SessionCompactAtSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = sessionOf(context);
  const request = await parseBody(context.request, SessionCompactAtPatchSchema);
  const { outcome } = await subsystem.set(sessionId, request.compactAt).catch(refuse);
  return jsonResponse({ ...outcome } satisfies SessionCompactAtPatchResult);
}

/** `noStore` because the answer is the live setting. */
export function sessionCompactAtRoutes(subsystem: SessionCompactAtSubsystem): readonly MountRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/ferrets/:ferretId/compact-at',
      handle: async context => jsonResponse(await subsystem.get(sessionOf(context)).catch(refuse)),
    },
    {
      method: 'PATCH',
      path: '/v1/ferrets/:ferretId/compact-at',
      handle: async context => await patch(subsystem, context),
    },
  ];
}
