import { ApiError, type ApiResponse, type CallContext, jsonResponse } from '@ferretry/kernel/contract';
import { parseBody } from '../../api/body.ts';
import { SessionConsoleInputRequestSchema, type SessionConsoleInputResult } from '../../protocol/session-processes.ts';
import { SessionAttachError } from '../../session/attach/index.ts';
import { SessionConsoleError } from '../../session/console/index.ts';
import { type FerretDirectory, knownFerret, pathFerret } from './ferret-path.ts';
import { ATTACH_REFUSALS } from './session-attach.ts';

/** Typing into one ferret's own pane; the pane is proved the way an attach proves it. */
export interface SessionConsoleSubsystem {
  write(sessionId: string, bytes: Uint8Array): Promise<number>;
}

function refuse(error: unknown): never {
  if (error instanceof SessionAttachError) {
    const refusal = ATTACH_REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  if (error instanceof SessionConsoleError) throw new ApiError(409, error.message, 'console_input_failed');
  throw error;
}

/**
 * `POST /v1/ferrets/:ferretId/console/input` — the Console, typeable from wherever the reader is.
 *
 * GOVERNED EXACTLY AS A TERMINAL IS, because it is one: `terminal.use`, at the `operator` minimum (the manifest's
 * descriptor). UNLIKE `/attach` it reveals nothing about the host: no socket path, no pane id, no pid. The answer
 * is a byte count. Audited as `terminal.input` (`detail.mode: 'console'`) by the descriptor, folded per window, and
 * never with what was typed (G30).
 */
export function consoleInputHandler(
  pane: SessionConsoleSubsystem,
  ferrets: FerretDirectory,
): (call: CallContext) => Promise<ApiResponse> {
  return async call => {
    const id = pathFerret(call);
    const request = await parseBody(call.request, SessionConsoleInputRequestSchema);
    await knownFerret(ferrets, id);
    const written = await pane.write(id, new TextEncoder().encode(request.data)).catch(refuse);
    const response: SessionConsoleInputResult = { written };
    return jsonResponse(response);
  };
}
