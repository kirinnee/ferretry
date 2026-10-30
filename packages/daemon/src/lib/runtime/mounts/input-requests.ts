import {
  InputCancelBodySchema,
  InputDeliverBodySchema,
  type InputActor,
  type InputRequestList,
} from '@ferretry/protocol';
import { isHumanAdminActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { InputRequestError } from '../../input-requests/errors.ts';
import type { InputCaller } from '../../input-requests/ports.ts';
import type { InputRequestService } from '../../input-requests/service.ts';

/**
 * THE OWNER'S ROUTES FOR INPUT REQUESTS (docs/input-requests.md).
 *
 * ## OWNER ONLY, TWICE
 *
 * A caller that identifies as an agent (`peer:` or `warden:`) is refused BEFORE the body is read, so
 * a value an agent tried to send is never parsed. The service refuses again unless the caller is a
 * person at the machine or a paired device. As everywhere else this is the honest-client boundary: an
 * agent that reads the admin token from the state home can call these as the host, which is the same
 * limit every other peer route declares (`isHumanAdminActor`).
 *
 * ## NO ROUTE RETURNS A VALUE
 *
 * Every body here is an `InputRequest`, an `InputDeliverResult` or an error whose message never carries
 * the value. The deliver body is parsed once, handed to the service and dropped.
 */

const STATUS: Readonly<Record<InputRequestError['code'], number>> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  capacity: 429,
  unavailable: 503,
  gone: 410,
};

function answered(error: unknown): never {
  if (error instanceof InputRequestError)
    throw new ApiError(STATUS[error.code], error.message, error.reason ?? error.code);
  throw error;
}

function ownerOf(context: RouteContext): InputCaller {
  const credential = context.credential;
  const device = credential?.tokenClass === 'device';
  if (!device && !isHumanAdminActor(context.actor))
    throw new ApiError(403, 'only the owner answers an input request; an agent cannot', 'forbidden');
  const actor: InputActor =
    credential?.tokenClass === 'device' ? { kind: 'device', deviceId: credential.deviceId } : { kind: 'host' };
  return { kind: 'owner', actor, carrier: device ? 'direct' : 'loopback' };
}

function sessionOf(context: RouteContext): string {
  const id = context.params.get('sessionId') ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))
    throw new ApiError(400, 'the session id in the path is not usable', 'bad_request');
  return id;
}

function requestOf(context: RouteContext): string {
  const id = context.params.get('requestId') ?? '';
  if (!/^[0-9a-f]{32}$/u.test(id)) throw new ApiError(400, 'the request id in the path is not usable', 'bad_request');
  return id;
}

async function list(service: InputRequestService, context: RouteContext, all: boolean): Promise<ApiResponse> {
  const caller = ownerOf(context);
  const requests = await service.list(caller, all ? undefined : sessionOf(context)).catch(answered);
  const body: InputRequestList = { requests: [...requests] };
  return jsonResponse(body);
}

export function inputRequestRoutes(service: InputRequestService): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/input-requests',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => await list(service, context, true),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/input-requests',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => await list(service, context, false),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/input-requests/:requestId/deliver',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = ownerOf(context);
        const body = await parseBody(context.request, InputDeliverBodySchema);
        return jsonResponse(
          await service.deliver(sessionOf(context), requestOf(context), body, caller).catch(answered),
        );
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/input-requests/:requestId/cancel',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = ownerOf(context);
        await parseBody(context.request, InputCancelBodySchema);
        return jsonResponse(await service.cancel(sessionOf(context), requestOf(context), caller).catch(answered));
      },
    },
  ];
}
