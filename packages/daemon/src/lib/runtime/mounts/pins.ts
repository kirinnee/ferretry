import { PinActionRequestSchema } from '@ferretry/protocol';
import { parseActor, type ApiActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { PinError, type PinActor, type PinErrorCode, type PinService } from '../../pins/index.ts';

/**
 * The pin board's HTTP surface: one session's pins, listed and mutated.
 *
 * This is the route table the CLI's `ProtocolPinGateway` already speaks — `GET` and `POST` on
 * `/v1/sessions/:sessionId/pins` — so mounting it is what turns the shipped `fy pin` commands from
 * calls into a 404 into a working capability.
 *
 * Both directions are parsed, never cast. The request body goes through the protocol's own
 * `PinActionRequestSchema`, so a malformed action is refused at the boundary with the failing field
 * named rather than reaching the domain as `any`.
 */

/** How each domain failure is reported. A pin error is a client error in every case: the domain only
 *  raises one when the request itself was wrong about the session, the pin, or the caller's right to
 *  touch it. Codes travel with the status so a client can branch without matching on prose. */
const PIN_ERROR_STATUS: Readonly<Record<PinErrorCode, number>> = {
  invalid: 400,
  'too-long': 400,
  'not-found': 404,
  forbidden: 403,
};

/**
 * The pin board's own idea of who is acting, derived from the actor the authorization boundary
 * resolved.
 *
 * Only an in-pane caller (`peer:<session>`) is an agent; the human's CLI and UI are `human`, which is
 * what lets them edit and remove a pin an agent created. Crucially the session id comes from the
 * SERVER-derived actor, so an agent cannot claim to be pinning for a session other than its own by
 * sending a different body — the domain's own "an agent may only pin to its own session" check has
 * something trustworthy to compare against.
 */
export function pinActor(actor: ApiActor | undefined): PinActor {
  const { kind, id } = parseActor(actor ?? '');
  return kind === 'peer' ? { sessionId: id } : {};
}

/** The path's session id, decoded. `decodeParameter` refuses a traversal or a separator, so a
 *  crafted id can never address a directory outside the session tree. */
function pathSessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined) throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

/** Re-raises a domain failure as its HTTP answer, and anything else as itself so a genuine bug still
 *  becomes a 500 instead of being reported as the client's fault. */
function reraise(error: unknown): never {
  if (error instanceof PinError) throw new ApiError(PIN_ERROR_STATUS[error.code], error.message, error.code);
  throw error;
}

async function list(pins: PinService, context: RouteContext): Promise<ApiResponse> {
  try {
    return jsonResponse(await pins.list(pathSessionId(context)));
  } catch (error) {
    return reraise(error);
  }
}

async function apply(pins: PinService, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseBody(context.request, PinActionRequestSchema);
  const actor = pinActor(context.actor);
  try {
    if (request.action === 'add') return jsonResponse(await pins.add(sessionId, request, actor));
    if (request.action === 'edit') return jsonResponse(await pins.edit(sessionId, request.id, request.text, actor));
    return jsonResponse(await pins.remove(sessionId, request.id, actor));
  } catch (error) {
    return reraise(error);
  }
}

/**
 * `admin` scope on both: a warden supervises sessions and has no business curating the human's
 * board, and the route table is where that decision belongs — a route that says nothing is
 * admin-only, so a subsystem cannot become warden-readable by forgetting to think about it.
 *
 * `noStore` because a pin board is live state; a cached board shows a pin the human already removed.
 */
export function pinRoutes(pins: PinService): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/pins',
      minimum: 'operator',
      noStore: true,
      handle: async context => await list(pins, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/pins',
      minimum: 'operator',
      noStore: true,
      handle: async context => await apply(pins, context),
    },
  ];
}
