import {
  type SessionCompactAt,
  type SessionCompactAtPatchResult,
  SessionCompactAtPatchSchema,
  type SessionView,
  type CompactAt,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { type CompactAtOutcome, SessionCompactAtError } from '../../session/compact-at/service.ts';

/**
 * Reading and setting where one ferret compacts its conversation: `GET` and `PATCH
 * /v1/sessions/:sessionId/compact-at` (docs/compact-at.md). `PATCH` answers the changed `SessionView`, the value a
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
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

async function patch(subsystem: SessionCompactAtSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = sessionOf(context);
  const request = await parseBody(context.request, SessionCompactAtPatchSchema);
  const { view, outcome } = await subsystem.set(sessionId, request.compactAt).catch(refuse);
  return jsonResponse({ view, ...outcome } satisfies SessionCompactAtPatchResult);
}

/** `noStore` because the answer is the live setting. */
export function sessionCompactAtRoutes(subsystem: SessionCompactAtSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/compact-at',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => jsonResponse(await subsystem.get(sessionOf(context)).catch(refuse)),
    },
    {
      method: 'PATCH',
      path: '/v1/sessions/:sessionId/compact-at',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await patch(subsystem, context),
    },
  ];
}
