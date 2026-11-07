import { ApiError, type ApiResponse, type CallContext, decodeParameter, jsonResponse } from '@ferretry/kernel/contract';
import { callerIsAgent, parseActor } from '@ferretry/core-gate/contract';
import type { ZodType } from 'zod';
import { BOARD_UNAVAILABLE_MESSAGE, BoardError, BoardUnavailableError, type BoardCaller } from '../lib/board/index.ts';
import { BoardSwitchUnavailableError, LaneSetUnavailableError } from '../lib/lanes/index.ts';
import type { BoardErrorCode } from '../../contract/index.ts';

/** The header a retried click carries: a retry gets the first start's answer. */
export const FY_REQUEST_ID_HEADER = 'x-fy-request-id';

/** The HTTP status each refusal answers with. */
export const BOARD_ERROR_STATUS: Readonly<Record<BoardErrorCode, number>> = {
  invalid: 400,
  'not-found': 404,
  forbidden: 403,
  'reason-required': 422,
  'owner-gate': 403,
  'blocked-by': 409,
  cycle: 409,
  'unknown-lane': 422,
  'no-lane-set': 409,
  'version-conflict': 409,
};

/** The first route-level fact: a body that is not the schema is a 400 naming what is wrong. */
export async function parseBody<T>(call: Pick<CallContext, 'request'>, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    const text = await call.request.text();
    raw = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not JSON', 'invalid');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(
      400,
      `the request body is not usable: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
      'invalid',
    );
  }
  return parsed.data;
}

/**
 * Who is writing, from the SERVER-DERIVED actor and credential, never from the body.
 *
 * - A ferret is its own bearer: such a caller is never the owner whatever its headers say.
 * - The owner is the human's own CLI or browser (`admin-cli`, `admin-ui`) or a paired device; the first two are
 *   recorded as `admin-token`, because a ferret holding that token looks exactly like them. A remote device reaches
 *   these routes only through the `fleet` capability; a loopback caller is ungoverned.
 *
 * Anything else (a warden, an agent with no ferret to name) is refused, never guessed at.
 */
export const boardCaller = (call: Pick<CallContext, 'actor' | 'credential'>): BoardCaller => {
  const credential = call.credential;
  if (credential?.tokenClass === 'ferret') return { kind: 'ferret', ferret: credential.ferret };
  const parsed = parseActor(call.actor ?? '');
  if (callerIsAgent(credential, call.actor)) {
    if (parsed.kind === 'ferret' && parsed.id !== undefined && parsed.id !== '')
      return { kind: 'ferret', ferret: parsed.id };
    throw new ApiError(403, 'an agent acts on the board only from its own ferret', 'forbidden');
  }
  if (parsed.kind === 'admin-cli' || parsed.kind === 'admin-ui') return { kind: 'owner', via: 'admin-token' };
  if (credential?.tokenClass === 'device' || (parsed.kind === 'device' && parsed.id !== undefined && parsed.id !== ''))
    return { kind: 'owner' };
  throw new ApiError(403, 'only a ferret in its own pane or the owner may write to the board', 'forbidden');
};

/** Re-raises a board refusal in the API's own terms; anything else propagates as the defect it is. */
export const reraiseBoardError = (error: unknown): never => {
  if (error instanceof BoardError) {
    throw new ApiError(
      BOARD_ERROR_STATUS[error.code],
      error.message,
      error.code,
      undefined,
      error.allowed.length === 0 ? undefined : { allowed: error.allowed },
    );
  }
  if (error instanceof BoardUnavailableError) throw new ApiError(503, BOARD_UNAVAILABLE_MESSAGE, 'unavailable');
  if (error instanceof LaneSetUnavailableError || error instanceof BoardSwitchUnavailableError)
    throw new ApiError(503, error.message, error.code);
  throw error;
};

export const answer = async (work: () => Promise<unknown>): Promise<ApiResponse> =>
  jsonResponse(await work().catch(reraiseBoardError));

/** The path parameter `name`, decoded; a 400 when it is missing. */
export const pathParameter = (call: Pick<CallContext, 'params'>, name: string, what: string): string => {
  const decoded = decodeParameter(call.params.get(name) ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, `the ${what} in the path is not usable`, 'invalid');
  return decoded;
};
