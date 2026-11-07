import type { SessionView } from '@ferretry/protocol';
import { AgentPinError, type AgentPinErrorCode } from '../../agent-pins/types.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * Pinning a ferret to the top of the owner's sidebar: `POST /v1/sessions/:sessionId/pin` and `…/unpin`.
 *
 * Both answer the session view, which carries `pinnedAt` while the ferret is pinned, and both are
 * idempotent: pinning a pinned ferret or unpinning an unpinned one answers the same view and changes
 * nothing. The pin list is the owner's own preference, so the routes are `operator` with NO capability
 * and `caller: 'person'` — a ferret is refused at the boundary before this runs — exactly like the shared
 * draft; docs/grants.md records the choice and a test pins it.
 */

export interface SessionPinSubsystem {
  pin(reference: string): Promise<SessionView>;
  unpin(reference: string): Promise<SessionView>;
}

const REFUSALS: Readonly<Record<AgentPinErrorCode, { readonly status: number; readonly code: string }>> = {
  'not-found': { status: 404, code: 'not-found' },
  full: { status: 409, code: 'pin_limit' },
};

function refuse(error: unknown): never {
  if (error instanceof AgentPinError) {
    const refusal = REFUSALS[error.code];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

async function change(apply: (reference: string) => Promise<SessionView>, context: RouteContext): Promise<ApiResponse> {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return jsonResponse(await apply(decoded).catch(refuse));
}

/** `noStore` because the answer is the live view of the ferret whose pin this call just changed. */
export function sessionPinRoutes(subsystem: SessionPinSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/pin',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => await change(reference => subsystem.pin(reference), context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/unpin',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => await change(reference => subsystem.unpin(reference), context),
    },
  ];
}
