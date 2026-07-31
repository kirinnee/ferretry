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
 * - `public` — no token at all. Reserved for the machine feeds external tools scrape.
 * - `warden` — the warden-scoped token, or the admin token.
 * - `admin` — the admin token only.
 */
export type RouteScope = 'public' | 'warden' | 'admin';

/** Everything a handler is allowed to know about the caller. */
export interface RouteContext {
  readonly request: ApiRequest;
  /** Path parameters, RAW. Decode with `decodeParameter`. */
  readonly params: RouteParameters;
  /** The server-derived identity of the caller. Never taken from the body or the query string, so
   *  a client cannot claim to be someone else. `undefined` on a `public` route. */
  readonly actor?: ApiActor;
}

export interface ApiRoute {
  readonly method: string;
  /** A pattern of literal segments, `:name` captures and a trailing `*name` catch-all. */
  readonly path: string;
  readonly scope: RouteScope;
  /** Set when the response may carry credentials, working-tree bytes, or a live machine feed whose
   *  entire value is freshness. */
  readonly noStore?: boolean;
  handle(context: RouteContext): Promise<ApiResponse>;
}
