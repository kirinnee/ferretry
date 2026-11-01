import { SessionConsoleInputRequestSchema, type SessionConsoleInputResult } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { SessionAttachError } from '../../session/attach/index.ts';
import { SessionConsoleError } from '../../session/console/index.ts';
import { ATTACH_REFUSALS } from './session-attach.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

/** Typing into one session's own pane; the pane is proved the way an attach proves it. */
export interface SessionConsoleSubsystem {
  write(sessionId: string, bytes: Uint8Array): Promise<number>;
}

function sessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

function refuse(error: unknown): never {
  if (error instanceof SessionAttachError) {
    const refusal = ATTACH_REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  if (error instanceof SessionConsoleError) throw new ApiError(409, error.message, 'console_input_failed');
  throw error;
}

async function input(
  pane: SessionConsoleSubsystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  const request = await parseBody(context.request, SessionConsoleInputRequestSchema);
  if ((await sessions.get(id)) === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
  const written = await pane.write(id, new TextEncoder().encode(request.data)).catch(refuse);
  const response: SessionConsoleInputResult = { written };
  return jsonResponse(response);
}

/**
 * `POST /v1/sessions/:sessionId/console/input` — the Console, typeable from wherever the reader is.
 *
 * GOVERNED EXACTLY AS A SESSION TERMINAL IS, because it is one: `terminal.use`, at the `operator`
 * minimum. A caller at this machine is ungoverned; a paired device, a browser across the network and a
 * relayed session all need the `terminal` grant and a current step-up — which the unlock holds by
 * default — and an undetermined grant document refuses. The authorization boundary decides all of it
 * from this declaration before the handler runs; nothing here re-derives who the caller is.
 *
 * UNLIKE `/attach` it reveals nothing about the host: no socket path, no pane id, no pid. The answer is
 * a byte count, so the route needs no `privilegedOnly` — what made attach loopback-only was the tmux
 * address it hands back, and this hands back none.
 *
 * Audited as `terminal.input` on the session, counted and folded per window like a terminal socket's
 * keystrokes, and never with what was typed (`audit/routes.ts`).
 */
export function sessionConsoleRoutes(
  pane: SessionConsoleSubsystem,
  sessions: SessionDirectorySubsystem,
): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/console/input',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => await input(pane, sessions, context),
    },
  ];
}
