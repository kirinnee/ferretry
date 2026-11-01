import {
  SessionProcessIdSchema,
  type SessionProcessList,
  type SessionProcessOutput,
  type SessionProcessStopResult,
} from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter, queryValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { SessionAttachError } from '../../session/attach/index.ts';
import { SessionProcessError, type SessionProcessFailure } from '../../session/processes/service.ts';
import { ATTACH_REFUSALS } from './session-attach.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

/** A ferret's processes: list, follow one's output, stop one. See `SessionProcessService`. */
export interface SessionProcessSubsystem {
  list(sessionId: string): Promise<SessionProcessList>;
  output(sessionId: string, processId: string, after: number | undefined): Promise<SessionProcessOutput>;
  stop(sessionId: string, processId: string): Promise<SessionProcessStopResult>;
}

const PROCESS_REFUSALS: Readonly<Record<SessionProcessFailure, { readonly status: number; readonly code: string }>> = {
  not_found: { status: 404, code: 'process_not_found' },
  changed: { status: 409, code: 'process_changed' },
  not_stoppable: { status: 409, code: 'process_not_stoppable' },
};

function sessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

function processId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('processId') ?? '');
  const parsed = SessionProcessIdSchema.safeParse(decoded);
  if (!parsed.success) throw new ApiError(400, 'the process id in the path is not usable', 'invalid_process_id');
  return parsed.data;
}

function after(context: RouteContext): number | undefined {
  const raw = queryValue(context.request, 'after');
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ApiError(400, 'query parameter "after" must be a byte offset', 'invalid_query');
  return value;
}

function refuse(error: unknown): never {
  if (error instanceof SessionProcessError) {
    const refusal = PROCESS_REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  if (error instanceof SessionAttachError) {
    const refusal = ATTACH_REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

async function known(sessions: SessionDirectorySubsystem, id: string): Promise<void> {
  if ((await sessions.get(id)) === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
}

/**
 * The Processes tab's three routes.
 *
 * `terminal` / `use` ON ALL THREE, because each is something a session terminal already lets its holder
 * do, and nothing a session terminal does not:
 *
 * - the LIST is every command line under the pane — what `ps` shows somebody with a shell there;
 * - an OUTPUT read is what those commands print, exactly what a terminal would show;
 * - STOP is SIGTERM to a command the agent started, which is less than typing Ctrl-C into the Console.
 *
 * So a caller at this machine is ungoverned, and a paired device, a browser across the network or a
 * relayed session needs the `terminal` grant and a current step-up — which the unlock holds by default —
 * exactly as the Console does (docs/grants.md). The authorization boundary decides that from these
 * declarations before any handler runs.
 *
 * Stop is audited as `terminal.input` (`detail.mode: 'process-stop'`): a person acting on the ferret's
 * pane, folded per window like a keystroke.
 */
export function sessionProcessRoutes(
  processes: SessionProcessSubsystem,
  sessions: SessionDirectorySubsystem,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/processes',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const id = sessionId(context);
        await known(sessions, id);
        return jsonResponse(await processes.list(id).catch(refuse));
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/processes/:processId/output',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async (context): Promise<ApiResponse> => {
        const id = sessionId(context);
        const process = processId(context);
        const offset = after(context);
        await known(sessions, id);
        return jsonResponse(await processes.output(id, process, offset).catch(refuse));
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/processes/:processId/stop',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const id = sessionId(context);
        const process = processId(context);
        await known(sessions, id);
        return jsonResponse(await processes.stop(id, process).catch(refuse));
      },
    },
  ];
}
