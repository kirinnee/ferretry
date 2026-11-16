/**
 * The routes a browser drives a harness login for one login through.
 *
 * ## `fleet.configure`, and NOT a second gate
 *
 * The concrete remote risk here is **account substitution**, not token theft. Nothing leaks: a caller who can start a
 * sign-in and forward its code can bind this machine to a provider account THEY control, and every ferret run
 * afterwards authenticates as that account. So every route that starts, reads, forwards to or ends a flow declares
 * `fleet`/`configure` (in the manifest), and a governed caller answers `step-up-required` until its device holds a
 * live passkey step-up. There is no new credential and no second refusal vocabulary.
 *
 * ## `noStore` on all four
 *
 * A live flow's status carries a verification URL somebody is in the middle of completing.
 *
 * ## Why one path family answers for two different flows
 *
 * The FLOWS are per harness and stay that way — two stage unions, two recognisers, two sets of state names. The
 * TRANSPORT is not: a flow id names one flow, and the projection it answers with is discriminated on `harness`.
 */
import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import type { z } from 'zod';
import {
  HarnessLoginFlowSchema,
  HarnessLoginStartRequestSchema,
  HarnessLoginSubmissionSchema,
  HarnessLoginSubmitRequestSchema,
} from '../../../contract/index.ts';
import { HarnessLoginRefusal, type HarnessLoginService } from '../harness-login/service.ts';
import { parseBody } from './body.ts';

/** The four calls, and the shutdown that ends every child they started. */
export type HarnessLoginSubsystem = Pick<HarnessLoginService, 'start' | 'status' | 'submit' | 'cancel'>;

/**
 * Every login refusal, in the transport's own taxonomy: `409` for all of them, so a client branches on the CODE.
 * `fleet_login_unauthorized` is deliberately not a 403: a 403 is "this credential may not reach this route", which
 * the capability layer already decided before this handler ran.
 */
const refusal = (error: HarnessLoginRefusal): ApiError => new ApiError(409, error.message, error.code);

/** Answer with a value proven against the contract the browser also parses. */
async function respondWith<Schema extends z.ZodType>(schema: Schema, work: () => Promise<unknown>) {
  try {
    return jsonResponse(schema.parse(await work()));
  } catch (error) {
    if (error instanceof HarnessLoginRefusal) throw refusal(error);
    throw error;
  }
}

const flowId = (params: ReadonlyMap<string, string>): string => {
  const id = decodeParameter(params.get('flowId') ?? '') ?? '';
  if (id === '') throw new ApiError(400, 'the sign-in id in the path is not usable', 'bad_request');
  return id;
};

export function signInRoutes(subsystem: HarnessLoginSubsystem) {
  return {
    /**
     * Start one login's sign-in. The body names a LOGIN and nothing else: it cannot name a command, a path or a
     * wrapper, so there is no shape of request that could point this at another program.
     */
    'POST /v1/logins/sign-in': (async call =>
      await respondWith(HarnessLoginFlowSchema, async () =>
        subsystem.start(await parseBody(call.request, HarnessLoginStartRequestSchema), call.governance),
      )) satisfies RouteHandler,
    'GET /v1/logins/sign-in/:flowId': (async call =>
      await respondWith(HarnessLoginFlowSchema, () => subsystem.status(flowId(call.params)))) satisfies RouteHandler,
    /**
     * Forward the one value a person brings back, or move a Codex device code to a link. The value travels in a BODY
     * (a query parameter reaches every proxy's access log), goes to the harness child and is retained nowhere.
     */
    'POST /v1/logins/sign-in/:flowId': (async call =>
      await respondWith(HarnessLoginSubmissionSchema, async () =>
        subsystem.submit(flowId(call.params), await parseBody(call.request, HarnessLoginSubmitRequestSchema)),
      )) satisfies RouteHandler,
    'DELETE /v1/logins/sign-in/:flowId': (async call =>
      await respondWith(HarnessLoginFlowSchema, () => subsystem.cancel(flowId(call.params)))) satisfies RouteHandler,
  };
}
