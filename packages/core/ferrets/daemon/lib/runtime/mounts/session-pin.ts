import { ApiError, type ApiResponse, type CallContext, decodeParameter, jsonResponse } from '@ferretry/kernel/contract';
import { AgentPinError, type AgentPinErrorCode } from '../../agent-pins/types.ts';
import type { PinnedFerret } from '../../agent-pins/view.ts';

/**
 * Pinning a ferret to the top of the owner's sidebar: `POST /v1/ferrets/:ferretId/pin` and `…/unpin`.
 *
 * Both answer the ferret, which carries `pinnedAt` while it is pinned, and both are idempotent: pinning a pinned
 * ferret or unpinning an unpinned one answers the same ferret and changes nothing. The pin list is the owner's own
 * preference, so the routes are `operator` with NO capability and `caller: 'person'` — a ferret is refused at the
 * boundary before this runs — exactly like the shared draft.
 */

export interface SessionPinSubsystem {
  pin(reference: string): Promise<PinnedFerret>;
  unpin(reference: string): Promise<PinnedFerret>;
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

async function change(apply: (reference: string) => Promise<PinnedFerret>, call: CallContext): Promise<ApiResponse> {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_session_id');
  return jsonResponse(await apply(decoded).catch(refuse));
}

/** The handlers for `POST /v1/ferrets/:ferretId/pin` and `…/unpin`; `noStore` in the manifest (a live answer). */
export function sessionPinRoutes(subsystem: SessionPinSubsystem) {
  return {
    pin: async (call: CallContext): Promise<ApiResponse> => await change(reference => subsystem.pin(reference), call),
    unpin: async (call: CallContext): Promise<ApiResponse> =>
      await change(reference => subsystem.unpin(reference), call),
  } as const;
}
