import type { ApiActor } from './actor.ts';
import type { ApiRequest, ApiResponse, RouteParameters } from './http.ts';

/**
 * Who may reach a route.
 *
 * The source decided this with a 60-line chain of path regexes evaluated before routing
 * (`wardenScopeDenial`), which meant every new subsystem had to remember to add its own denial or
 * silently became warden-readable — and several did. Here the answer travels WITH the route, so a
 * route that says nothing is admin-only by construction and forgetting to think about scope fails
 * closed instead of open.
 *
 * - `public` — no token at all. Reserved for machine feeds and one-time-code redemption.
 * - `warden` — any authenticated caller, including the capability-scoped warden.
 * - `admin` — a host admin or paired device acting as the operator.
 * - `host` — the host's admin token only; never a remote device or warden.
 */
export type RouteScope = 'public' | 'warden' | 'admin' | 'host';

/** Everything a handler is allowed to know about the caller. */
export interface RouteContext {
  readonly request: ApiRequest;
  /** Path parameters, RAW. Decode with `decodeParameter`. */
  readonly params: RouteParameters;
  /** The server-derived identity of the caller. Never taken from the body or the query string, so
   *  a client cannot claim to be someone else. `undefined` on a `public` route. */
  readonly actor?: ApiActor;
}

/**
 * The least a router needs to match a request: a verb and a path pattern.
 *
 * Named separately because the daemon has TWO route tables — request/response routes and the
 * protocol-switching socket routes — and one router matching both is what keeps a socket path from
 * being matched by rules that disagree with the ones authorization applied.
 */
export interface RoutePattern {
  readonly method: string;
  /** A pattern of literal segments, `:name` captures and a trailing `*name` catch-all. */
  readonly path: string;
}

/** A route whose reachability is decided by the token class that authenticated the request. Shared
 *  by both tables, so one authorization boundary serves both and neither can drift. */
export interface ScopedRoute extends RoutePattern {
  readonly scope: RouteScope;
}

export interface ApiRoute extends ScopedRoute {
  /** Set when the response may carry credentials, working-tree bytes, or a live machine feed whose
   *  entire value is freshness. */
  readonly noStore?: boolean;
  handle(context: RouteContext): Promise<ApiResponse>;
}
