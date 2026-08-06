import { resolveApiActor, type TokenClass } from './actor.ts';
import { type ApiCredentials, authenticate, bearerToken } from './authentication.ts';
import { type CapabilityGuard, grantRefusalCode } from './capability.ts';
import { ApiError } from './error.ts';
import { type ApiRequest, type ApiResponse, headerValue, queryValue } from './http.ts';
import { errorResponse, methodNotAllowedResponse, noStore, unknownRouteResponse } from './responses.ts';
import type { ApiRoute, RouteContext, ScopedRoute } from './route.ts';
import type { ApiRouter } from './router.ts';
import { SOCKET_TICKET_QUERY_PARAMETER, type SocketTicketRedeemer } from './socket-ticket.ts';

/** The pane's own session id, so an in-pane caller is attributed to itself rather than to the
 *  shared token it holds. */
export const SESSION_ID_HEADER = 'x-ferretry-session-id';
/** Client self-identification (`cli`), which is what tells `admin-cli` from `admin-ui`. */
export const CLIENT_HEADER = 'x-ferretry-client';
/** Query parameter carrying a token for WebSocket upgrades, which cannot set headers. Honoured for
 *  loopback peers only. */
export const TOKEN_QUERY_PARAMETER = 'token';
/** The unlock a `configure`-axis caller presents. A header, never a query parameter: a URL reaches
 *  every proxy's access log, and an unlock in a log outlives its five minutes. */
export const OPERATOR_UNLOCK_HEADER = 'x-ferretry-operator-unlock';

/** What the authorization boundary decided about one request. */
export type RouteAuthorization<TRoute extends ScopedRoute> =
  | { readonly kind: 'authorized'; readonly route: TRoute; readonly context: RouteContext }
  | { readonly kind: 'refused'; readonly response: ApiResponse }
  /**
   * No route in THIS table claims the path, and the caller was authenticated, so saying so leaks
   * nothing. What it means is the caller's to decide: the request/response dispatcher answers 404,
   * while the socket dispatcher hands the request back to be served as ordinary HTTP.
   */
  | { readonly kind: 'unrouted' };

/**
 * Route, authenticate, authorize, attribute — everything that must be settled before a handler or a
 * protocol switch is reached.
 *
 * It is shared by BOTH route tables rather than repeated per transport. That is what makes
 * "authentication happens on the upgrade" true by construction: a socket cannot be reached over
 * credentials the request/response surface would have refused, warden scope is enforced the same
 * way on both, and the loopback query-parameter token — the only credential a browser `WebSocket`
 * can carry — is honoured on identical terms.
 *
 * The order matters and differs from the source in one way worth naming. Unknown-route and
 * wrong-verb answers are produced only AFTER authentication succeeds, so an unauthenticated caller
 * cannot map the daemon's private surface by watching 404 turn into 405. Public routes are answered
 * before authentication is even attempted, because that is the whole point of being public.
 */
export function authorizeRequest<TRoute extends ScopedRoute>(
  router: ApiRouter<TRoute>,
  credentials: ApiCredentials,
  request: ApiRequest,
  tickets?: SocketTicketRedeemer,
  guard?: CapabilityGuard,
): RouteAuthorization<TRoute> {
  const lookup = router.lookup(request.method, request.path);
  if (lookup.kind === 'matched' && lookup.route.minimum === 'none')
    return { kind: 'authorized', route: lookup.route, context: { request, params: lookup.params } };

  const presented = authenticate(credentials, {
    bearer: bearerToken(headerValue(request, 'authorization')),
    // A token in a URL is logged by every proxy in the path, so it is accepted only from a peer
    // that could already read the token file it came from.
    query: request.loopback ? queryValue(request, TOKEN_QUERY_PARAMETER) : undefined,
  });
  // A ticket is the credential a browser CAN present on an upgrade, and only the upgrade boundary
  // passes a redeemer — an ordinary route is given none, so a ticket read out of an access log
  // authenticates nothing there. It is tried only when the request could not authenticate on its own,
  // so a caller holding a real bearer never silently spends a single-use ticket.
  const authentication =
    presented.kind === 'anonymous' && tickets !== undefined && lookup.kind === 'matched'
      ? (tickets.redeem(queryValue(request, SOCKET_TICKET_QUERY_PARAMETER) ?? '', request.path) ?? presented)
      : presented;
  if (authentication.kind === 'anonymous')
    return { kind: 'refused', response: errorResponse(401, 'unauthorized', 'unauthorized') };

  if (lookup.kind === 'not-found') return { kind: 'unrouted' };
  if (lookup.kind === 'method-not-allowed')
    return {
      kind: 'refused',
      response: methodNotAllowedResponse(request.method, request.path, lookup.allowed),
    };

  if (!meetsMinimum(authentication.tokenClass, lookup.route.minimum) ||
      (lookup.route.privilegedOnly === true && !request.loopback))
    return {
      kind: 'refused',
      response: errorResponse(
        403,
        `the presented credential may not use ${request.method} ${request.path}`,
        'forbidden',
      ),
    };

  // Server-derived, unforgeable: the token class decides warden versus admin, and the self-
  // identification headers only refine WHICH warden or peer. The source also flipped the class to
  // `warden` whenever a stop-capability header was merely PRESENT, so an admin CLI that passed one
  // had its own actions journalled as the warden's.
  const actor = resolveApiActor({
    tokenClass: authentication.tokenClass,
    deviceId: authentication.tokenClass === 'device' ? authentication.deviceId : undefined,
    sessionId: headerValue(request, SESSION_ID_HEADER),
    client: headerValue(request, CLIENT_HEADER),
  });
  /**
   * The OPERATOR's answer, asked last and able only to take away.
   *
   * The order is the substance. Authentication has already happened, the route's own scope has
   * already been enforced, and the actor has already been derived from evidence the caller cannot
   * forge — so by the time a grant is consulted the request is one this daemon WOULD have served, and
   * the only thing this can do is decline it. That is the invariant, made structural: there is no
   * branch here that produces `authorized` for a request the code above refused.
   *
   * IT FAILS CLOSED ON A MISSING GUARD. A route that names a capability and a dispatcher that was
   * built without a guard is a wiring mistake, and the safe reading of "nobody can tell me whether
   * this is allowed" is that it is not. Serving it would be the exact damaged-state-as-empty-state
   * defect this product has already been bitten by three times.
   */
  const demand = lookup.route.capability;
  if (demand !== undefined) {
    const decision = guard?.decide(demand, {
      // The TRANSPORT's answer, never a header's. A relayed hop terminates on this very host, so
      // anything derived from an address would read as local and hand a remote caller the machine.
      loopback: request.loopback,
      actor,
      unlock: headerValue(request, OPERATOR_UNLOCK_HEADER),
    }) ?? { allowed: false, refusal: 'undetermined' as const };
    if (!decision.allowed)
      return {
        kind: 'refused',
        response: errorResponse(
          403,
          guard?.explain(demand, decision.refusal) ??
            `this daemon cannot say whether the UI may use ${demand.capability}, so it is refusing`,
          grantRefusalCode(decision.refusal),
        ),
      };
  }
  return {
    kind: 'authorized',
    route: lookup.route,
    context: { request, params: lookup.params, actor, credential: authentication },
  };
}

function meetsMinimum(tokenClass: TokenClass, minimum: ScopedRoute['minimum']): boolean {
  switch (minimum) {
    case 'none':
    case 'authenticated':
      return true;
    case 'operator':
      return tokenClass !== 'warden';
    case 'admin-token':
      return tokenClass === 'admin';
  }
}

/** Turns a request into a response, over the shared authorization boundary above. */
export class ApiDispatcher {
  constructor(
    private readonly router: ApiRouter,
    private readonly credentials: ApiCredentials,
    /** The operator's per-capability decision. Absent only in tables that name no capability — a
     *  governed route reached through a guardless dispatcher is refused, never served. */
    private readonly guard?: CapabilityGuard,
  ) {}

  async dispatch(request: ApiRequest): Promise<ApiResponse> {
    const authorized = authorizeRequest(this.router, this.credentials, request, undefined, this.guard);
    if (authorized.kind === 'unrouted') return unknownRouteResponse(request.method, request.path);
    if (authorized.kind === 'refused') return authorized.response;
    return await run(authorized.route, authorized.context);
  }
}

async function run(route: ApiRoute, context: RouteContext): Promise<ApiResponse> {
  let response: ApiResponse;
  try {
    response = await route.handle(context);
  } catch (error) {
    response =
      error instanceof ApiError
        ? errorResponse(error.status, error.message, error.code)
        : errorResponse(500, 'the daemon failed to handle this request', 'internal_error');
  }
  return route.noStore === true ? noStore(response) : response;
}
