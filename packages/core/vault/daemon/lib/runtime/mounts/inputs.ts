import {
  CAPABILITIES,
  grantRefusalCode,
  isFerretCall,
  OWNER_ONLY_CODE,
  ownerOnlyWords,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/core-gate/contract';
import {
  ApiError,
  type ApiResponse,
  type CallContext,
  type CapabilityAxis,
  jsonResponse,
  type PlainApiResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import type { z } from 'zod';
import type { InputShot } from '../../../../contract/index.ts';
import { InputRequestError } from '../../inputs/errors.ts';
import type { InputCaller } from '../../inputs/ports.ts';
import type { InputRequestService } from '../../inputs/service.ts';
import {
  type InputActor,
  InputCancelBodySchema,
  InputDeliverBodySchema,
  type InputQuarantineList,
  type InputRequest,
  type InputRequestList,
} from '../../inputs/wire.ts';

/**
 * THE OWNER'S ROUTES FOR INPUT REQUESTS (today's `runtime/mounts/input-requests.ts`; the phone-approval routes are
 * Accounts'). Paths keep today's words except `/v1/sessions/:sessionId/…`, which is `/v1/ferrets/:ferretId/…` (§1.4).
 *
 * ## OWNER ONLY, TWICE
 *
 * A caller that is a ferret (or the warden) is refused BEFORE the body is read, so a value a ferret tried to send is
 * never parsed. The service refuses again unless the caller is a person at the machine or a paired device.
 *
 * ## NO ROUTE RETURNS A VALUE
 *
 * Every body here is an `InputRequest`, an `InputDeliverResult` or an error whose message never carries the value.
 * The deliver body is parsed once, handed to the service and dropped.
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

/**
 * The owner a route was called by: the person at the machine or a paired device. Refuses a ferret before any body is
 * read, in the one owner-only sentence and code, naming the route's own act (`act`: "answers an input request").
 */
function ownerActorOf(
  call: CallContext,
  act = 'answers an input request',
): Extract<InputActor, { readonly kind: 'host' | 'device' }> {
  if (isFerretCall(call)) throw new ApiError(403, ownerOnlyWords(act), OWNER_ONLY_CODE);
  const credential = call.credential;
  return credential?.kind === 'authenticated' && credential.tokenClass === 'device'
    ? { kind: 'device', deviceId: credential.principal.holder }
    : { kind: 'host' };
}

function ownerOf(call: CallContext): InputCaller {
  const actor = ownerActorOf(call);
  return { kind: 'owner', actor, carrier: actor.kind === 'device' ? 'direct' : 'loopback' };
}

function ferretOf(call: CallContext): string {
  const id = call.params.get('ferretId') ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))
    throw new ApiError(400, 'the ferret id in the path is not usable', 'bad_request');
  return id;
}

function requestOf(call: CallContext): string {
  const id = call.params.get('requestId') ?? '';
  if (!/^[0-9a-f]{32}$/u.test(id)) throw new ApiError(400, 'the request id in the path is not usable', 'bad_request');
  return id;
}

/** Today's `parseBody`: JSON, then the strict schema; a refusal names no value. */
async function parseBody<S extends z.ZodType>(call: CallContext, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await call.request.text();
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not JSON', 'bad_request');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'the request body is not valid', 'bad_request');
  return parsed.data;
}

// ─── another capability behind a terminal route (today's `secret-write-grant.ts`, the part these routes use) ─────

/** One more demand behind a route that already passed its own: the refusal, or `undefined` when allowed. */
function refusedExtra(
  call: CallContext,
  demand: { readonly capability: 'secrets' | 'browser'; readonly axis: CapabilityAxis },
  act: string,
  consequence: string,
): ApiResponse | undefined {
  const governance = call.governance;
  if (governance === undefined)
    return jsonResponse(
      { error: `this daemon cannot say whether this caller may ${act}, so it is refusing`, code: 'forbidden' },
      403,
    );
  const decision = governance.decide({ capability: CAPABILITIES[demand.capability], axis: demand.axis });
  if (decision.allowed) return undefined;
  if (decision.refusal === 'step-up-required')
    return jsonResponse(
      {
        error: `${act} from this device needs a passkey confirmation`,
        code: STEP_UP_REQUIRED_CODE,
        demand,
      } satisfies StepUpRequiredBody,
      403,
    );
  return jsonResponse(
    { error: `this device may not ${act}: ${consequence}`, code: grantRefusalCode(decision.refusal) },
    403,
  );
}

const refusedSecretWrite = (call: CallContext, act: string): ApiResponse | undefined =>
  refusedExtra(call, { capability: 'secrets', axis: 'configure' }, act, 'that changes the secret store');
const refusedPageInput = (call: CallContext, act = 'allow a value into a page'): ApiResponse | undefined =>
  refusedExtra(call, { capability: 'browser', axis: 'use' }, act, 'that needs the browser permission');
const refusedAccountNames = (call: CallContext, act: string): ApiResponse | undefined =>
  refusedExtra(call, { capability: 'secrets', axis: 'use' }, act, 'that needs the secrets permission');

/** After an allowed secret write: a governed caller's single-use step-up is spent, as for `POST /v1/secrets`. */
function spentSecretWrite(call: CallContext): void {
  if (call.governance?.governed === true) call.spendFreshStepUp?.();
}

// ─── the routes ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A request as a caller that may not read ACCOUNT NAMES sees it (no `secrets.use`): no `saved` at all (G89, I43).
 */
function nameless(request: InputRequest): InputRequest {
  const { saved: _names, ...rest } = request;
  return rest;
}

async function list(service: InputRequestService, call: CallContext, all: boolean): Promise<ApiResponse> {
  const caller = ownerOf(call);
  const requests = await service.list(caller, all ? undefined : ferretOf(call)).catch(answered);
  const names = refusedAccountNames(call, 'read the accounts a card names') === undefined;
  // A hold taken since the service answered still wins, now and again as the dispatcher sends it.
  const spell = (): PlainApiResponse => {
    const body: InputRequestList = {
      requests: requests.map(request => service.resealed(names ? request : nameless(request))),
    };
    return jsonResponse(body);
  };
  return { ...spell(), late: spell };
}

/** The handlers, by the route keys `manifest.ts` declares (descriptors are today's, field for field). */
export function inputRequestRoutes(service: InputRequestService) {
  return {
    'GET /v1/input-requests': async call => await list(service, call, true),
    'GET /v1/ferrets/:ferretId/input-requests': async call => await list(service, call, false),
    // The picture of a page request's fields, taken before anything was typed. Owner only.
    'GET /v1/ferrets/:ferretId/input-requests/:requestId/shot': async call => {
      const caller = ownerOf(call);
      const shot: InputShot = (() => {
        try {
          return service.shot(caller, ferretOf(call), requestOf(call));
        } catch (error) {
          return answered(error);
        }
      })();
      return jsonResponse(shot);
    },
    'POST /v1/ferrets/:ferretId/input-requests/:requestId/deliver': async call => {
      const caller = ownerOf(call);
      // A paste into the secret store changes it, so it needs what `POST /v1/secrets` needs as well.
      const target = service.targetOf(ferretOf(call), requestOf(call))?.kind;
      const intoStore = target === 'secret';
      const refused = intoStore
        ? refusedSecretWrite(call, 'allow a paste into the secret store')
        : target === 'page'
          ? refusedPageInput(call)
          : undefined;
      if (refused !== undefined) return refused;
      const body = await parseBody(call, InputDeliverBodySchema);
      // Typing a saved account needs `secrets.use`; keeping a typed value in one needs `secrets.configure` (I43).
      const accounts =
        (body.entry === undefined ? undefined : refusedAccountNames(call, 'type a saved account')) ??
        (body.save === undefined ? undefined : refusedSecretWrite(call, 'save a value to Accounts'));
      if (accounts !== undefined) return accounts;
      const result = await service.deliver(ferretOf(call), requestOf(call), body, caller).catch(answered);
      if (intoStore || body.save !== undefined) spentSecretWrite(call);
      return jsonResponse(result);
    },
    'GET /v1/ferrets/:ferretId/input-quarantines': async call => {
      const body: InputQuarantineList = { quarantines: [...service.quarantines(ownerOf(call), ferretOf(call))] };
      return jsonResponse(body);
    },
    'POST /v1/ferrets/:ferretId/input-quarantines/:key/end': async call => {
      const caller = ownerOf(call);
      const key = call.params.get('key') ?? '';
      await service.endQuarantine(caller, ferretOf(call), key).catch(answered);
      return jsonResponse({ ended: true });
    },
    'POST /v1/ferrets/:ferretId/input-requests/:requestId/cancel': async call => {
      const caller = ownerOf(call);
      await parseBody(call, InputCancelBodySchema);
      return jsonResponse(await service.cancel(ferretOf(call), requestOf(call), caller).catch(answered));
    },
  } satisfies Readonly<Record<string, RouteHandler>>;
}
