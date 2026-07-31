import { resolveApiActor } from './actor.ts';
import { authenticate, bearerToken, type ApiCredentials } from './authentication.ts';
import { ApiError } from './error.ts';
import { headerValue, queryValue, type ApiRequest, type ApiResponse } from './http.ts';
import { errorResponse, methodNotAllowedResponse, noStore, unknownRouteResponse } from './responses.ts';
import type { ApiRoute, RouteContext } from './route.ts';
import type { ApiRouter } from './router.ts';

/** The pane's own session id, so an in-pane caller is attributed to itself rather than to the
 *  shared token it holds. */
export const SESSION_ID_HEADER = 'x-ferretry-session-id';
/** Client self-identification (`cli`), which is what tells `admin-cli` from `admin-ui`. */
export const CLIENT_HEADER = 'x-ferretry-client';
/** Query parameter carrying a token for WebSocket upgrades, which cannot set headers. Honoured for
 *  loopback peers only. */
export const TOKEN_QUERY_PARAMETER = 'token';

/**
 * Turns a request into a response: route, authenticate, authorize, attribute, handle.
 *
 * The order matters and differs from the source in one way worth naming. Unknown-route and
 * wrong-verb answers are produced only AFTER authentication succeeds, so an unauthenticated caller
 * cannot map the daemon's private surface by watching 404 turn into 405. Public routes are answered
 * before authentication is even attempted, because that is the whole point of being public.
 */
export class ApiDispatcher {
  constructor(
    private readonly router: ApiRouter,
    private readonly credentials: ApiCredentials,
  ) {}

  async dispatch(request: ApiRequest): Promise<ApiResponse> {
    const lookup = this.router.lookup(request.method, request.path);
    if (lookup.kind === 'matched' && lookup.route.scope === 'public')
      return await run(lookup.route, { request, params: lookup.params });

    const authentication = authenticate(this.credentials, {
      bearer: bearerToken(headerValue(request, 'authorization')),
      // A token in a URL is logged by every proxy in the path, so it is accepted only from a peer
      // that could already read the token file it came from.
      query: request.loopback ? queryValue(request, TOKEN_QUERY_PARAMETER) : undefined,
    });
    if (authentication.kind === 'anonymous') return errorResponse(401, 'unauthorized', 'unauthorized');

    if (lookup.kind === 'not-found') return unknownRouteResponse(request.method, request.path);
    if (lookup.kind === 'method-not-allowed')
      return methodNotAllowedResponse(request.method, request.path, lookup.allowed);

    if (lookup.route.scope === 'admin' && authentication.tokenClass === 'warden')
      return errorResponse(403, `the warden-scoped token may not use ${request.method} ${request.path}`, 'forbidden');

    // Server-derived, unforgeable: the token class decides warden versus admin, and the self-
    // identification headers only refine WHICH warden or peer. The source also flipped the class to
    // `warden` whenever a stop-capability header was merely PRESENT, so an admin CLI that passed one
    // had its own actions journalled as the warden's.
    const actor = resolveApiActor({
      tokenClass: authentication.tokenClass,
      sessionId: headerValue(request, SESSION_ID_HEADER),
      client: headerValue(request, CLIENT_HEADER),
    });
    return await run(lookup.route, { request, params: lookup.params, actor });
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
