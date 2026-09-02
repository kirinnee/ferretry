/**
 * The routes a browser drives a harness login — and a credential renewal — through.
 *
 * ## Why a renewal is here, and why it is ONE route rather than five
 *
 * A renewal is the sibling of a sign-in and never a sign-in. It asks the harness to rotate a credential
 * it can already rotate: nobody is sent anywhere, no browser opens, no code comes back, and there is no
 * window to expire. So it needs no flow id, no status poll, no submit and no cancel — one request, one
 * answer. Modelling it as a flow would have added four routes that could only ever say "finished".
 *
 * It sits under the same `fleet`/`configure` and the same per-change confirmation as a start, and that
 * is not caution: a rotation the provider REFUSES makes the harness clear its own tokens, so a caller
 * who can drive this from off the machine can leave an identity needing a person. The authorization is
 * literally the same code path — see `#authorize` — so the two cannot drift apart on the ORDER of the
 * checks, which is where a refusal that should have cost nothing starts costing a password attempt.
 *
 * ## `fleet.configure`, and NOT a second gate
 *
 * The concrete remote risk here is **account substitution**, not token theft. Nothing leaks: a caller who
 * can start a login and forward its code can bind this fleet to a provider account THEY control, and
 * every agent run afterwards authenticates as that account. That is a change to how the host behaves, so
 * every route that starts, reads, forwards to or ends a flow declares `fleet`/`configure`.
 *
 * `configure` implies `use`, both axes default to enabled, and a governed caller answers `locked` until an
 * unlock is held — so this is not a default change, it is which lock the operator's password reaches. The
 * START additionally proves that password against this one sign-in, using the SAME three pieces the
 * fleet's proposal apply already wires: the flag the boundary sets, the check the grant service performs,
 * and the `'operator-password'` answer a panel reads before somebody clicks. There is no new credential,
 * no new attempt budget, and no second refusal vocabulary — the last time a fleet capability grew its own
 * authority system it took a week to remove.
 *
 * The READINESS read is the one exception and it is `fleet`/`use`, beside `/v1/fleet/accounts`, because it
 * is a read: nothing is launched and nothing on the host changes. What it discloses — which accounts are
 * signed in, when a token expires, and where each credential comes from — is the same class of fact the
 * roster already puts on the wire for any caller with `fleet.use`.
 *
 * `minimum: 'operator'` matches every other fleet route. An `admin-token` minimum would 403 the browser,
 * which is always a paired device, and the browser is the whole point of the feature.
 *
 * ## `noStore` on all five
 *
 * A live flow's status carries a verification URL somebody is in the middle of completing. A cached one
 * hands a later reader a link into a sign-in that has since finished and hands an intermediary one into a
 * sign-in that has not.
 *
 * ## Why one path family answers for two different flows
 *
 * The FLOWS are per harness and stay that way — two stage unions, two recognisers, two sets of state
 * names. The TRANSPORT is not: a flow id names one flow, and the projection it answers with is
 * discriminated on `harness`, so a reader narrows once and then holds exactly one harness's own states.
 * The one place this shows is the submit route, which a Codex flow always REFUSES — because Codex
 * completes at the provider and has nothing to bring back. That refusal is information rather than an
 * error, and it is worth a route that can say it: the alternative is a surface that silently offers a
 * paste box for a harness that cannot read one.
 */
import {
  FleetLoginReadinessSchema,
  FleetRenewalRequestSchema,
  FleetRenewalSchema,
  HarnessLoginFlowSchema,
  HarnessLoginStartRequestSchema,
  HarnessLoginSubmissionSchema,
  HarnessLoginSubmitRequestSchema,
} from '@ferretry/protocol';
import type { z } from 'zod';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { HarnessLoginRefusal, type HarnessLoginService } from '../../fleet-login/service.ts';

/** The subsystem these routes serve. Narrowed to the five calls plus the read. */
export type HarnessLoginSubsystem = Pick<
  HarnessLoginService,
  'readiness' | 'start' | 'status' | 'submit' | 'cancel' | 'renew'
>;

/**
 * Every login refusal, in the transport's own taxonomy.
 *
 * `409` for all of them, which is what the fleet's own refusals already answer with, so a client branches
 * on the CODE rather than on a status the whole family shares. `fleet_login_unauthorized` is deliberately
 * not a 403: a 403 is "this credential may not reach this route", which the capability layer already
 * decided before this handler ran, and answering it again here would tell a caller with every right to be
 * here that it has none.
 */
function refusal(error: HarnessLoginRefusal): ApiError {
  return new ApiError(409, error.message, error.code);
}

/** Answer with a value proven against the contract the browser also parses. */
async function respondWith<Schema extends z.ZodType>(schema: Schema, work: () => Promise<unknown>) {
  try {
    return jsonResponse(schema.parse(await work()));
  } catch (error) {
    if (error instanceof HarnessLoginRefusal) throw refusal(error);
    throw error;
  }
}

function flowId(context: RouteContext): string {
  const id = decodeParameter(context.params.get('flowId') ?? '') ?? '';
  if (id === '') throw new ApiError(400, 'the sign-in id in the path is not usable', 'bad_request');
  return id;
}

export function harnessLoginRoutes(subsystem: HarnessLoginSubsystem): readonly ApiRoute[] {
  return [
    {
      /**
       * Which provider logins this host has, and what each one needs.
       *
       * A READ, so `fleet.use`. It is the read the whole feature was blocked on: no route returned a
       * credential classification, and no wire schema carried the word `refreshable`, so a UI had no way
       * to say WHICH accounts need signing in — only that some session's quota readout said `auth!`.
       */
      method: 'GET',
      path: '/v1/fleet/login',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => await respondWith(FleetLoginReadinessSchema, () => subsystem.readiness()),
    },
    {
      /**
       * Start one identity's sign-in.
       *
       * The body names an ACCOUNT and, when this caller owes one, the operator password. It cannot name a
       * command, a path or a wrapper: the daemon resolves which wrapper to launch from the manifest, so
       * there is no shape of request that could point this at another program.
       */
      method: 'POST',
      path: '/v1/fleet/login',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context =>
        await respondWith(HarnessLoginFlowSchema, async () =>
          subsystem.start(await parseBody(context.request, HarnessLoginStartRequestSchema), context.governance),
        ),
    },
    {
      method: 'GET',
      path: '/v1/fleet/login/:flowId',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context => await respondWith(HarnessLoginFlowSchema, () => subsystem.status(flowId(context))),
    },
    {
      /**
       * Forward the one value a person brings back.
       *
       * A POST carrying an explicit human intent, like the browser login window's actions, and the value
       * travels in a BODY: a query parameter reaches every proxy's access log, and this one is an
       * authorization code. It is written to the harness child's stdin and retained nowhere — not here,
       * not on the flow, not in the answer, and not in the grant audit journal.
       */
      method: 'POST',
      path: '/v1/fleet/login/:flowId',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context =>
        await respondWith(HarnessLoginSubmissionSchema, async () =>
          subsystem.submit(flowId(context), (await parseBody(context.request, HarnessLoginSubmitRequestSchema)).code),
        ),
    },
    {
      method: 'DELETE',
      path: '/v1/fleet/login/:flowId',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context => await respondWith(HarnessLoginFlowSchema, () => subsystem.cancel(flowId(context))),
    },
    {
      /**
       * Renew one account's credential, with no browser and nobody sent anywhere.
       *
       * NOT UNDER `/v1/fleet/login/`, and that is the router's arithmetic rather than taste: every path
       * there is `:flowId`, so a literal segment beside it would be read as the id of a flow that does
       * not exist. It is its own address for its own act.
       *
       * The body names an ACCOUNT and, when this caller owes one, the operator password. Same shape and
       * same gate as a start, because from the host's point of view it is the same act: somebody off
       * this machine causing a credential to be rewritten in a home on it.
       *
       * Every ending is a value. `not-expired`, `not-renewable`, `not-required` and `indeterminate` are
       * `200`s that say nothing was fired and why — a renewal that correctly refused to spend a rotating
       * refresh token is not an error, and answering `409` for it would teach a surface to show a
       * failure for the case the whole gate exists to produce.
       */
      method: 'POST',
      path: '/v1/fleet/renew',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context =>
        await respondWith(FleetRenewalSchema, async () =>
          subsystem.renew(await parseBody(context.request, FleetRenewalRequestSchema), context.governance),
        ),
    },
  ];
}
