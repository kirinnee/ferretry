import { ApiError, type ApiResponse, type CallContext, jsonResponse } from '@ferretry/kernel/contract';
import { PinError, type PinActor, type PinErrorCode, type PinService } from '../../pins/index.ts';
import { PinActionRequestSchema } from '../../protocol/pins.ts';

/**
 * The pin board's HTTP surface: one ferret's pins, listed and mutated (`GET` and `POST` on
 * `/v1/ferrets/:ferretId/pins`).
 *
 * Both directions are parsed, never cast. The request body goes through `PinActionRequestSchema`, so a malformed
 * action is refused at the boundary with the failing field named rather than reaching the domain as `any`.
 */

/** How each domain failure is reported. A pin error is a client error in every case: the domain only raises one when
 *  the request itself was wrong about the ferret, the pin, or the caller's right to touch it. Codes travel with the
 *  status so a client can branch without matching on prose. */
const PIN_ERROR_STATUS: Readonly<Record<PinErrorCode, number>> = {
  invalid: 400,
  'too-long': 400,
  'not-found': 404,
  forbidden: 403,
};

/** Who the pin board is told is acting: the agent's own ferret, from its token, or nobody (a person). */
export interface PinCaller {
  /** Whether the caller is an agent (a ferret's token, the warden, or the admin token with a ferret behind it). */
  readonly isAgent: boolean;
  /** The ferret the caller's own credential names, when it names one. */
  readonly ferret?: string;
}

/**
 * The pin board's own idea of who is acting.
 *
 * Only an agent caller is an agent; the human's CLI and UI are `human`, which is what lets them edit and remove a pin
 * an agent created. Crucially the ferret id comes from the SERVER-derived credential, so an agent cannot claim to be
 * pinning for a ferret other than its own by sending a different body. An agent with no ferret to name is refused,
 * never taken for a person.
 */
export function pinActor(caller: PinCaller): PinActor {
  if (!caller.isAgent) return {};
  const id = caller.ferret;
  if (id === undefined || id.trim() === '')
    throw new ApiError(403, 'an agent pins only from its own session', 'forbidden');
  return { sessionId: id };
}

/** Re-raises a domain failure as its HTTP answer, and anything else as itself so a genuine bug still becomes a 500. */
function reraise(error: unknown): never {
  if (error instanceof PinError) throw new ApiError(PIN_ERROR_STATUS[error.code], error.message, error.code);
  throw error;
}

async function parseAction(call: CallContext) {
  const text = await call.request.text();
  let raw: unknown;
  try {
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not JSON', 'invalid_json');
  }
  const parsed = PinActionRequestSchema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      400,
      'the request body is not valid',
      'invalid_request',
      parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
    );
  return parsed.data;
}

export interface PinRouteDeps {
  readonly pins: PinService;
  /** The ferret the path names (an id or a name), or a refusal. */
  ferretOf(call: CallContext): Promise<string>;
  callerOf(call: CallContext): PinCaller;
}

/**
 * The handlers for `GET` and `POST /v1/ferrets/:ferretId/pins`. `noStore` (in the manifest) because a pin board is
 * live state; a cached board shows a pin the human already removed.
 */
export function pinRoutes(deps: PinRouteDeps) {
  return {
    list: async (call: CallContext): Promise<ApiResponse> => {
      const ferret = await deps.ferretOf(call);
      return jsonResponse(await deps.pins.list(ferret).catch(reraise));
    },
    apply: async (call: CallContext): Promise<ApiResponse> => {
      const ferret = await deps.ferretOf(call);
      const request = await parseAction(call);
      const actor = pinActor(deps.callerOf(call));
      try {
        if (request.action === 'add') return jsonResponse(await deps.pins.add(ferret, request, actor));
        if (request.action === 'edit')
          return jsonResponse(await deps.pins.edit(ferret, request.id, request.text, actor));
        return jsonResponse(await deps.pins.remove(ferret, request.id, actor));
      } catch (error) {
        return reraise(error);
      }
    },
  } as const;
}
