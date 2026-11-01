import { type SessionHypermediaPatchResult, SessionHypermediaPatchSchema, type SessionView } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { type HypermediaOutcome, SessionHypermediaError } from '../../session/hypermedia/service.ts';

/**
 * Switching whether one ferret is told to use hypermedia: `PATCH /v1/sessions/:sessionId/hypermedia`
 * (docs/hypermedia.md). The answer is the switched `SessionView`, whether a restart is needed for it to
 * take effect, and that said in words.
 *
 * `operator` scope and no capability, like rename: it is a write to a session's own configuration, it
 * grants nothing, and it changes only what the ferret is told at its next launch.
 */
export interface SessionHypermediaSubsystem {
  set(
    sessionId: string,
    enabled: boolean,
  ): Promise<{ readonly view: SessionView; readonly outcome: HypermediaOutcome }>;
}

function refuse(error: unknown): never {
  if (error instanceof SessionHypermediaError) throw new ApiError(404, error.message, 'not-found');
  throw error;
}

async function set(subsystem: SessionHypermediaSubsystem, context: RouteContext): Promise<ApiResponse> {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  const request = await parseBody(context.request, SessionHypermediaPatchSchema);
  const { view, outcome } = await subsystem.set(decoded, request.enabled).catch(refuse);
  return jsonResponse({ view, ...outcome } satisfies SessionHypermediaPatchResult);
}

/** `noStore` because the answer is a live session view carrying the switch this call changed. */
export function sessionHypermediaRoutes(subsystem: SessionHypermediaSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'PATCH',
      path: '/v1/sessions/:sessionId/hypermedia',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await set(subsystem, context),
    },
  ];
}
