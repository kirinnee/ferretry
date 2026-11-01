import { type RenameSessionRequest, RenameSessionRequestSchema, type SessionView } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { SessionRenameError, type SessionRenameFailure } from '../../names/session-names.ts';

/**
 * Renaming an agent: `POST /v1/sessions/:sessionId/rename`.
 *
 * `IFyApiClient.rename` has always posted here and the daemon answered `unknown_route`, so the PWA's
 * rename sheet could only fail. The body is the wire's `RenameSessionRequest`: a new first name
 * (`teammate`, the callsign grammar, any case), a new task title (`name`), or both. The answer is the
 * renamed `SessionView`, the same shape every other session write answers with.
 *
 * `operator` scope and no capability, like the stop, the signal and the migration: it is a write to a
 * session's own configuration, and `SessionRenameService` says who may make it and why.
 */

/** One rename, from the parsed request to the view the caller will see. */
export interface SessionRenameSubsystem {
  rename(sessionId: string, request: RenameSessionRequest, actor: string): Promise<SessionView>;
}

/** The HTTP status and code each refusal answers with. */
const REFUSALS: Readonly<Record<SessionRenameFailure, { readonly status: number; readonly code: string }>> = {
  invalid: { status: 400, code: 'invalid_request' },
  not_found: { status: 404, code: 'not-found' },
  taken: { status: 409, code: 'name_taken' },
  unsupported: { status: 400, code: 'rename_unsupported' },
  unavailable: { status: 503, code: 'name_unavailable' },
  failed: { status: 500, code: 'session_rename_failed' },
};

/** Restates a rename refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof SessionRenameError) {
    const refusal = REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

async function rename(subsystem: SessionRenameSubsystem, context: RouteContext): Promise<ApiResponse> {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  const request = await parseBody(context.request, RenameSessionRequestSchema);
  // The actor is the boundary's, never the body's; an unauthenticated request never reaches here.
  const view = await subsystem.rename(decoded, request, context.actor ?? 'unknown').catch(refuse);
  return jsonResponse(view);
}

/** `noStore` because the answer is a live session view carrying exactly the names this call changed. */
export function sessionRenameRoutes(subsystem: SessionRenameSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/rename',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await rename(subsystem, context),
    },
  ];
}
