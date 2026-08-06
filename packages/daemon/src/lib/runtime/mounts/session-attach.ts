import type { SessionAttachTarget } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { SessionAttachError, type SessionAttachFailure } from '../../session/attach/index.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

/** The daemon-authoritative attach proof. */
export interface SessionAttachSubsystem {
  resolve(sessionId: string): Promise<SessionAttachTarget>;
}

const REFUSALS: Readonly<Record<SessionAttachFailure, { readonly status: number; readonly code: string }>> = {
  missing_registration: { status: 409, code: 'attach_registration_missing' },
  pane_unavailable: { status: 409, code: 'attach_pane_unavailable' },
  identity_mismatch: { status: 409, code: 'attach_identity_mismatch' },
  // Multiple or malformed durable records are damaged state, not a transiently absent pane.
  ambiguous_registration: { status: 500, code: 'attach_registration_ambiguous' },
  invalid_registration: { status: 500, code: 'attach_registration_invalid' },
};

function sessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

function refuse(error: unknown): never {
  if (error instanceof SessionAttachError) {
    const refusal = REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

async function attachTarget(
  attach: SessionAttachSubsystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  // A filesystem socket on the daemon host cannot be acted on by a remote client. Refusing here is
  // safer than handing a remote caller a path it might coincidentally have on a different machine.
  if (!context.request.loopback)
    throw new ApiError(403, 'attaching requires a client on the daemon host', 'attach_not_local');
  const id = sessionId(context);
  const session = await sessions.get(id);
  if (session === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
  try {
    return jsonResponse(await attach.resolve(id));
  } catch (error) {
    return refuse(error);
  }
}

/**
 * The only route that reveals a host tmux address.
 *
 * `admin` and loopback are both required: this hands a human an interactive terminal, and the path
 * is meaningful only on the machine whose daemon proved the process identity. `noStore` because the
 * proof is short-lived — a resume replaces the pane and invalidates it immediately.
 */
export function sessionAttachRoutes(
  attach: SessionAttachSubsystem,
  sessions: SessionDirectorySubsystem,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/attach',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async context => await attachTarget(attach, sessions, context),
    },
  ];
}
