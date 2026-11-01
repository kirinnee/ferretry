import { type SessionCredentialRevoked, SessionCredentialRevokedSchema } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * CUTTING A FERRET OFF: `POST /v1/sessions/:sessionId/revoke-credential` (`fy session revoke-credential`,
 * docs/agent-tools.md § "Cutting a ferret off").
 *
 * The session's credential is revoked at once: the value its pane holds names nobody from this moment, so
 * its `fy`, its MCP server and its agent tools are refused as an unknown credential. A running pane keeps
 * running without them until its next launch, which is handed a fresh credential as every launch is — so
 * to keep a ferret cut off, stop it as well.
 *
 * A PERSON'S ACT (`caller: 'person'`): a ferret never revokes a credential, its own or another's — refusing
 * it before the handler means a prompt-injected ferret cannot knock its peers off Ferretry either. Like the
 * stop it sits beside, it is `operator` with no capability: it only ever takes access away.
 *
 * `noStore`: the answer is a live session status.
 */
export interface SessionCredentialSubsystem {
  revoke(sessionId: string): Promise<SessionCredentialRevoked>;
}

/** Why a revocation could not be served. */
export type SessionCredentialFailure = 'not_found';

/** A refusal the composition root raises, in a taxonomy `src/lib` may name. */
export class SessionCredentialError extends Error {
  constructor(
    readonly failure: SessionCredentialFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionCredentialError';
  }
}

const REFUSALS: Readonly<Record<SessionCredentialFailure, { readonly status: number; readonly code: string }>> = {
  not_found: { status: 404, code: 'not-found' },
};

async function revoke(subsystem: SessionCredentialSubsystem, context: RouteContext) {
  const id = decodeParameter(context.params.get('sessionId') ?? '');
  if (id === undefined || id === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  const revoked = await subsystem.revoke(id).catch((error: unknown) => {
    if (error instanceof SessionCredentialError) {
      const refusal = REFUSALS[error.failure];
      throw new ApiError(refusal.status, error.message, refusal.code);
    }
    throw error;
  });
  return jsonResponse(SessionCredentialRevokedSchema.parse(revoked));
}

export function sessionCredentialRoutes(subsystem: SessionCredentialSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/revoke-credential',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => await revoke(subsystem, context),
    },
  ];
}
