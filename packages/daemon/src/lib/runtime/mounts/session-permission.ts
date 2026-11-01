import {
  type PermissionAnswerRequest,
  PermissionAnswerRequestSchema,
  type PermissionAnswerResult,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { SessionAttachError } from '../../session/attach/index.ts';
import { SessionConsoleError } from '../../session/console/index.ts';
import { PermissionAnswerError } from '../../session/permission/index.ts';
import { ATTACH_REFUSALS } from './session-attach.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

/** Answering the permission prompt on one session's own pane; see `SessionPermissionService`. */
export interface SessionPermissionSubsystem {
  answer(sessionId: string, answer: PermissionAnswerRequest): Promise<PermissionAnswerResult>;
}

function sessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

function refuse(error: unknown): never {
  if (error instanceof PermissionAnswerError)
    throw error.refusal === 'gone'
      ? new ApiError(409, error.message, 'permission_prompt_gone')
      : new ApiError(400, error.message, 'invalid_permission_choice');
  if (error instanceof SessionAttachError) {
    const refusal = ATTACH_REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  if (error instanceof SessionConsoleError) throw new ApiError(409, error.message, 'console_input_failed');
  throw error;
}

async function answer(
  permission: SessionPermissionSubsystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  const request = await parseBody(context.request, PermissionAnswerRequestSchema);
  if ((await sessions.get(id)) === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
  return jsonResponse(await permission.answer(id, request).catch(refuse));
}

/**
 * `POST /v1/sessions/:sessionId/permission` — answering the harness's tool-permission prompt from
 * wherever the reader is.
 *
 * GOVERNED EXACTLY AS THE CONSOLE IS, because an answer is keystrokes into the same pane:
 * `terminal.use`, at the `operator` minimum. A caller at this machine is ungoverned; a paired device,
 * a browser across the network and a relayed session — a relay terminates on this host, so "remote"
 * is decided from the carrier, never from an address — all need the `terminal` grant. The
 * authorization boundary decides it from this declaration before the handler runs.
 *
 * Audited as `terminal.input` on the session, like every other write to the pane, and never with the
 * choice that was made.
 */
export function sessionPermissionRoutes(
  permission: SessionPermissionSubsystem,
  sessions: SessionDirectorySubsystem,
): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/permission',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => await answer(permission, sessions, context),
    },
  ];
}
