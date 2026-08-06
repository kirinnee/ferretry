import { type ApiActor, resolveApiActor, type TokenClass } from './actor.ts';
import { type ApiCredentials, authenticate, bearerToken } from './authentication.ts';
import { type CapabilityGuard, grantRefusalCode } from './capability.ts';
import { ApiError } from './error.ts';
import { type ApiRequest, type ApiResponse, headerValue, queryValue, type RouteParameters } from './http.ts';
import { errorResponse, methodNotAllowedResponse, noStore, unknownRouteResponse } from './responses.ts';
import type { ApiRoute, RouteContext, ScopedRoute, WardenRemedyAuthorizer } from './route.ts';
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
/**
 * The per-assignment capability a warden presents to exercise a remedy.
 *
 * IT REFINES, IT NEVER ESTABLISHES. What makes a caller a warden is the token it authenticated with,
 * and nothing else; this header can only say WHICH warden assignment is acting among callers already
 * proven to be one. An admin or a device credential carrying it stays an admin or a device — for
 * authorization, for attribution, and for whether the remedy question is asked at all. The source
 * made the opposite choice, flipping the class to `warden` whenever a capability header was merely
 * present, which handed anyone who could guess a header name a second identity.
 */
export const WARDEN_CAPABILITY_HEADER = 'x-fy-warden-capability';

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
 * before authentication is even attempted, because that is the whole point of being public — unless
 * one also declares a warden remedy, which is a route asking for a check it just skipped past; that
 * one is served the long way, and the shortcut below says why.
 *
 * THE FULL ORDER, AND IT IS STRUCTURAL RATHER THAN CONVENTIONAL — there is no branch below that
 * produces `authorized` for a request an earlier step refused:
 *
 * 1. authenticate;
 * 2. enforce the route's credential minimum and privileged-arrival flag;
 * 3. derive the actor from the token class alone, never from a header that claims a class;
 * 4. ask the operator's capability grant, which can only take away;
 * 5. ask the administrator's warden-remedy authorizer, and ONLY for a caller the token class already
 *    proved to be a warden.
 */
export function authorizeRequest<TRoute extends ScopedRoute>(
  router: ApiRouter<TRoute>,
  credentials: ApiCredentials,
  request: ApiRequest,
  tickets: SocketTicketRedeemer | undefined,
  guard: CapabilityGuard,
  /**
   * The administrator's per-remedy answer, absent on a boundary that serves no remedy routes.
   *
   * OPTIONAL HERE, FAIL-CLOSED THERE: a table with no remedy declaration never consults it, and a
   * table that grows one and is served without an authorizer refuses every warden rather than
   * quietly acquiring a bypass — the same rule the capability guard already states for itself.
   */
  remedies?: WardenRemedyAuthorizer,
): RouteAuthorization<TRoute> {
  const lookup = router.lookup(request.method, request.path);
  // The public shortcut answers before authentication is even attempted, which is the whole point of
  // being public — but it is a shortcut past EVERY check below, so it may only be taken by a route
  // that asks for none of them. A `none` route that also declared a warden remedy would be served to
  // anyone at all, remedy and authorizer unconsulted, which is the loudest possible version of the
  // failure this axis exists to prevent. Such a route is served the long way instead: authentication
  // still refuses an anonymous caller, and a warden still has to satisfy the remedy.
  if (lookup.kind === 'matched' && lookup.route.minimum === 'none' && lookup.route.wardenRemedy === undefined)
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

  if (
    !meetsMinimum(authentication.tokenClass, lookup.route.minimum) ||
    (lookup.route.privilegedOnly === true && !request.loopback)
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
  /**
   * The OPERATOR's answer, asked last and able only to take away.
   *
   * The order is the substance. Authentication has already happened, the route's credential and
   * privileged-arrival requirements have already been enforced, and the actor has already been derived from evidence the caller cannot
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
    const decision = guard.decide(demand, {
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
          guard.explain(demand, decision.refusal) ??
            `this daemon cannot say whether the UI may use ${demand.capability}, so it is refusing`,
          grantRefusalCode(decision.refusal),
        ),
      };
  }
  const remedyRefusal = wardenRemedyRefusal(
    lookup.route,
    authentication.tokenClass,
    request,
    lookup.params,
    actor,
    remedies,
  );
  if (remedyRefusal !== undefined) return { kind: 'refused', response: remedyRefusal };
  return {
    kind: 'authorized',
    route: lookup.route,
    context: { request, params: lookup.params, actor, credential: authentication },
  };
}

/**
 * The ADMINISTRATOR's answer, asked last and only of a warden.
 *
 * THE FIRST LINE IS THE WHOLE SECURITY PROPERTY. The token class decides who is subject to this
 * question, and the token class is what the presented credential proved — so an admin or a device
 * that carries {@link WARDEN_CAPABILITY_HEADER} is simply not asked, keeps the authority its own
 * class already earned, and keeps its own attribution. The header cannot promote a caller INTO this
 * check and cannot excuse a caller out of the checks above it.
 *
 * Every path back out of here is either `undefined` — this axis has nothing to say — or a 403 that
 * names what would allow the operation. A denial that says only "forbidden" is a dead end: the
 * warden cannot tell a missing setting from a missing capability from a daemon that was wired wrong,
 * and each of those has a different next step.
 */
function wardenRemedyRefusal(
  route: ScopedRoute,
  tokenClass: TokenClass,
  request: ApiRequest,
  params: RouteParameters,
  actor: ApiActor,
  remedies: WardenRemedyAuthorizer | undefined,
): ApiResponse | undefined {
  if (tokenClass !== 'warden') return undefined;
  const capability = headerValue(request, WARDEN_CAPABILITY_HEADER)?.trim() ?? '';
  const declared = route.wardenRemedy;
  if (declared === undefined) {
    // A route that declares no remedy is one no warden may act on. Serving the request anyway
    // because the header "did not apply" is how forgetting to declare would come to mean unchecked.
    if (capability === '') return undefined;
    return errorResponse(
      403,
      `${request.method} ${request.path} declares no warden remedy, so a warden capability cannot authorize it; drop ${WARDEN_CAPABILITY_HEADER} and use a credential that may reach this route on its own`,
      'warden_remedy_undeclared',
    );
  }
  const remedy = declared.trim();
  // A blank declaration is a wiring fault, not a permissive one. `WardenRemedyName` is `string`, so
  // nothing stopped it being written; asking an authorizer to rule on a nameless remedy, or naming
  // one in a refusal, would carry the gap forward instead of stopping at it.
  if (remedy === '')
    return errorResponse(
      403,
      `${request.method} ${request.path} declares a blank warden remedy, so this daemon cannot say what a warden would be doing here and is refusing; the route must name the remedy it means`,
      'warden_remedy_undetermined',
    );
  if (capability === '')
    return errorResponse(
      403,
      `a warden may ${remedy} here only by presenting the capability of the assignment it was given, in ${WARDEN_CAPABILITY_HEADER}`,
      'warden_capability_required',
    );
  if (remedies === undefined)
    return errorResponse(
      403,
      `this daemon was built with no warden remedy authorizer, so it cannot say whether a warden may ${remedy} here and is refusing; the route declares a remedy and the boundary serving it must be wired with one`,
      'warden_remedy_undetermined',
    );
  const decision = remedies.decide({ remedy, request, params, capability, actor });
  if (decision === undefined || (!decision.allowed && decision.refusal.trim() === ''))
    // A refusal with nothing to say is not a quieter refusal, it is an unfinished one — and rendering
    // its empty sentence would produce exactly the opaque 403 this axis promises never to emit. It is
    // read as no decision, and the boundary says what it can say on its own.
    return errorResponse(
      403,
      `this daemon reached no decision about whether a warden may ${remedy} here, so it is refusing; an administrator must allow this remedy for the assignment that was given`,
      'warden_remedy_undetermined',
    );
  return decision.allowed ? undefined : errorResponse(403, decision.refusal.trim(), 'warden_remedy_refused');
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
    /** The operator's per-capability decision, including an explicit no-governed-routes guard. */
    private readonly guard: CapabilityGuard,
    /** The administrator's per-remedy decision. Absent while this table declares no remedy — and a
     *  table that declares one without it refuses every warden, rather than serving one unchecked. */
    private readonly remedies?: WardenRemedyAuthorizer,
  ) {}

  async dispatch(request: ApiRequest): Promise<ApiResponse> {
    const authorized = authorizeRequest(this.router, this.credentials, request, undefined, this.guard, this.remedies);
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
