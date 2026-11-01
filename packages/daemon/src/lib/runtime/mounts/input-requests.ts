import {
  type InputActor,
  InputCancelBodySchema,
  InputDeliverBodySchema,
  type InputQuarantineList,
  type InputRequest,
  type InputRequestList,
  type InputShot,
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
import { refusedPageInput, refusedSecretWrite, spentSecretWrite } from './secret-write-grant.ts';

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

export function answered(error: unknown): never {
  if (error instanceof InputRequestError)
    throw new ApiError(STATUS[error.code], error.message, error.reason ?? error.code);
  throw error;
}

/** The owner a route was called by: the person at the machine or a paired device. Refuses an agent before any body is read. */
export function ownerActorOf(context: RouteContext): Extract<InputActor, { readonly kind: 'host' | 'device' }> {
  const credential = context.credential;
  if (credential?.tokenClass !== 'device' && !isHumanAdminActor(context.actor))
    throw new ApiError(403, 'only the owner answers an input request; an agent cannot', 'forbidden');
  return credential?.tokenClass === 'device' ? { kind: 'device', deviceId: credential.deviceId } : { kind: 'host' };
}

export function ownerOf(context: RouteContext): InputCaller {
  const actor = ownerActorOf(context);
  return { kind: 'owner', actor, carrier: actor.kind === 'device' ? 'direct' : 'loopback' };
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

/** Mirrors the notice `InputRequestService` masks a quarantined terminal's facts with. */
const QUARANTINE_NOTICE = '[hidden: a secret was just typed in this terminal]';

/** A request as it may be spelled right now: a terminal quarantined since the service answered reads as masked. */
function sealed(service: InputRequestService, request: InputRequest): InputRequest {
  const facts = request.observed;
  if (facts?.kind !== 'terminal' || service.quarantinedUntil(request.sessionId, [request.target.key]) === undefined)
    return request;
  return {
    ...request,
    observed: {
      ...facts,
      promptLine: QUARANTINE_NOTICE,
      foreground: { ...facts.foreground, comm: QUARANTINE_NOTICE, argv: '' },
    },
  };
}

async function list(service: InputRequestService, context: RouteContext, all: boolean): Promise<ApiResponse> {
  const caller = ownerOf(context);
  const requests = await service.list(caller, all ? undefined : sessionOf(context)).catch(answered);
  // A hold taken since the service answered still wins, now and again as the dispatcher sends it.
  const spell = (): ApiResponse => {
    const body: InputRequestList = { requests: requests.map(request => sealed(service, request)) };
    return jsonResponse(body);
  };
  return { ...spell(), late: spell };
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
      // The picture of a page request's fields, taken before anything was typed: the owner's card draws the
      // boxes on it. Owner only, like everything about a request but the raise.
      method: 'GET',
      path: '/v1/sessions/:sessionId/input-requests/:requestId/shot',
      minimum: 'operator',
      capability: { capability: 'browser', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = ownerOf(context);
        const shot: InputShot = (() => {
          try {
            return service.shot(caller, sessionOf(context), requestOf(context));
          } catch (error) {
            return answered(error);
          }
        })();
        return jsonResponse(shot);
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/input-requests/:requestId/deliver',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = ownerOf(context);
        // A paste into the secret store changes it, so it needs what `POST /v1/secrets` needs as well.
        const target = service.targetOf(sessionOf(context), requestOf(context))?.kind;
        const intoStore = target === 'secret';
        const refused = intoStore
          ? refusedSecretWrite(context, 'allow a paste into the secret store')
          : target === 'browser'
            ? refusedPageInput(context)
            : undefined;
        if (refused !== undefined) return refused;
        const body = await parseBody(context.request, InputDeliverBodySchema);
        // A deliver naming a 2FA key is for a daemon that checks the key is the matched account's and holds a seed;
        // this one makes a code from the saved login's only seed, so it refuses rather than ignore the owner's pick.
        if (body.factor !== undefined)
          throw new ApiError(400, 'this machine does not make codes per 2FA key yet; update it first', 'bad_request');
        const result = await service.deliver(sessionOf(context), requestOf(context), body, caller).catch(answered);
        if (intoStore) spentSecretWrite(context);
        return jsonResponse(result);
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/input-quarantines',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: context => {
        const body: InputQuarantineList = {
          quarantines: [...service.quarantines(ownerOf(context), sessionOf(context))],
        };
        return Promise.resolve(jsonResponse(body));
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/input-quarantines/:key/end',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const caller = ownerOf(context);
        const key = context.params.get('key') ?? '';
        await service.endQuarantine(caller, sessionOf(context), key).catch(answered);
        return jsonResponse({ ended: true });
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
