import { resolveApiActor } from './actor.ts';
import { type ApiCredentials, authenticate, bearerToken } from './authentication.ts';
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
): RouteAuthorization<TRoute> {
  const lookup = router.lookup(request.method, request.path);
  if (lookup.kind === 'matched' && lookup.route.scope === 'public')
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
    presented.kind === 'anonymous' && tickets !== undefined
      ? (tickets.redeem(queryValue(request, SOCKET_TICKET_QUERY_PARAMETER) ?? '') ?? presented)
      : presented;
  if (authentication.kind === 'anonymous')
    return { kind: 'refused', response: errorResponse(401, 'unauthorized', 'unauthorized') };

  if (lookup.kind === 'not-found') return { kind: 'unrouted' };
  if (lookup.kind === 'method-not-allowed')
    return {
      kind: 'refused',
      response: methodNotAllowedResponse(request.method, request.path, lookup.allowed),
    };

  if (
    (lookup.route.scope === 'host' && authentication.tokenClass !== 'admin') ||
    (lookup.route.scope === 'admin' && authentication.tokenClass === 'warden')
  )
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
  return {
    kind: 'authorized',
    route: lookup.route,
    context: { request, params: lookup.params, actor, credential: authentication },
  };
}

/** Turns a request into a response, over the shared authorization boundary above. */
export class ApiDispatcher {
  constructor(
    private readonly router: ApiRouter,
    private readonly credentials: ApiCredentials,
  ) {}

  async dispatch(request: ApiRequest): Promise<ApiResponse> {
    const authorized = authorizeRequest(this.router, this.credentials, request);
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
