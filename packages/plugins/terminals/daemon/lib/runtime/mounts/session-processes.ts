import {
  ApiError,
  type ApiResponse,
  type CallContext,
  decodeParameter,
  jsonResponse,
  queryValue,
} from '@ferretry/kernel/contract';
import {
  SessionProcessIdSchema,
  type SessionProcessList,
  type SessionProcessOutput,
  type SessionProcessStopResult,
} from '../../protocol/session-processes.ts';
import { SessionAttachError } from '../../session/attach/index.ts';
import { SessionProcessError, type SessionProcessFailure } from '../../session/processes/service.ts';
import { type FerretDirectory, knownFerret, pathFerret } from './ferret-path.ts';
import { ATTACH_REFUSALS } from './session-attach.ts';

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

function processId(call: CallContext): string {
  const decoded = decodeParameter(call.params.get('processId') ?? '');
  const parsed = SessionProcessIdSchema.safeParse(decoded);
  if (!parsed.success) throw new ApiError(400, 'the process id in the path is not usable', 'invalid_process_id');
  return parsed.data;
}

function after(call: CallContext): number | undefined {
  const raw = queryValue(call.request, 'after');
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

/**
 * The Processes tab's three routes (G34): `terminal` / `use` on all three, because each is something a ferret's
 * terminal already lets its holder do — the LIST is every command line under the pane, an OUTPUT read is what those
 * commands print, STOP is SIGTERM to a command the agent started (less than typing Ctrl-C into the Console). The
 * manifest's descriptors carry that, and Stop is audited as `terminal.input`. Every string they answer is scrubbed
 * by the service (S17); the route guard is `secrets`.
 */
export function processHandlers(
  processes: SessionProcessSubsystem,
  ferrets: FerretDirectory,
): {
  readonly list: (call: CallContext) => Promise<ApiResponse>;
  readonly output: (call: CallContext) => Promise<ApiResponse>;
  readonly stop: (call: CallContext) => Promise<ApiResponse>;
} {
  return {
    list: async call => {
      const id = pathFerret(call);
      await knownFerret(ferrets, id);
      return jsonResponse(await processes.list(id).catch(refuse));
    },
    output: async call => {
      const id = pathFerret(call);
      const process = processId(call);
      const offset = after(call);
      await knownFerret(ferrets, id);
      return jsonResponse(await processes.output(id, process, offset).catch(refuse));
    },
    stop: async call => {
      const id = pathFerret(call);
      const process = processId(call);
      await knownFerret(ferrets, id);
      return jsonResponse(await processes.stop(id, process).catch(refuse));
    },
  };
}
