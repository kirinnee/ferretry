import type { ApiActor } from './actor.ts';
import type { CapabilityDemand } from './capability.ts';
import type { ApiRequest, ApiResponse, RouteParameters } from './http.ts';
import type { AuthenticatedCredential } from './socket-ticket.ts';

/**
 * Who may reach a route.
 *
 * The source decided this with a 60-line chain of path regexes evaluated before routing
 * (`wardenScopeDenial`), which meant every new subsystem had to remember to add its own denial or
 * silently became warden-readable — and several did. Here the answer travels WITH the route, so a
 * route that says nothing is refused by construction and forgetting to think about reachability fails
 * closed instead of open.
 *
 * THIS IS ONE OF THREE INDEPENDENT QUESTIONS, and they were once a single `scope` value that could only
 * ever answer whichever one its author had in mind:
 *
 * - **`minimum`** — the least CREDENTIAL CLASS that may reach the route. That is this type.
 * - **`privilegedOnly`** — whether the request must have ARRIVED over a privileged carrier, which is a
 *   fact about the transport and not about the token. See {@link ScopedRoute}.
 * - **`capability`** — what the OPERATOR must additionally have agreed the UI may do, consulted only
 *   after the two above pass, so a grant can never widen. See {@link ScopedRoute.capability}.
 *
 * The classes, weakest first:
 *
 * - `none` — no token at all. Reserved for machine feeds and one-time-code redemption.
 * - `authenticated` — any caller this daemon issued a credential to, including a paired device and the
 *   capability-scoped warden. For reads whose subject is the caller and whose body holds no secret.
 * - `operator` — an admin token or a paired device acting as the operator; never the warden.
 * - `admin-token` — the host's own admin token only; never a remote device, never the warden.
 */
export type CredentialMinimum = 'none' | 'authenticated' | 'operator' | 'admin-token';

/** Everything a handler is allowed to know about the caller. */
export interface RouteContext {
  readonly request: ApiRequest;
  /** Path parameters, RAW. Decode with `decodeParameter`. */
  readonly params: RouteParameters;
  /** The server-derived identity of the caller. Never taken from the body or the query string, so
   *  a client cannot claim to be someone else. `undefined` on a `public` route. */
  readonly actor?: ApiActor;
  /**
   * WHICH credential authenticated the request — server-derived exactly like `actor`, and absent on a
   * `public` route for the same reason.
   *
   * A handler needs this only to mint something that must not outrank its caller, which the socket
   * ticket is the one route to do today. It is deliberately not the actor: an actor string is for
   * attribution and is lossy about authority, so deriving a class back out of one would be guessing.
   */
  readonly credential?: AuthenticatedCredential;
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
  /** The least credential class that may reach this route. */
  readonly minimum: CredentialMinimum;
  /** Whether the request must have arrived through a privileged carrier. */
  readonly privilegedOnly?: true;
  /**
   * What the OPERATOR must additionally have agreed to, when this route is one of the five things
   * they are asked about.
   *
   * A SECOND, NARROWER QUESTION stacked on the route declaration, never a replacement for it. The
   * credential minimum and privileged-arrival flag are the daemon's own contract about which caller
   * may reach a route; this is the machine owner's answer to "and of those, which have I agreed the UI may do?". The route checks run first
   * and a demand is consulted only after it passes, so a grant can only ever remove authority — never
   * hand a credential something its class was refused.
   *
   * ABSENT MEANS UNGOVERNED, NOT UNGUARDED. Most of the daemon's surface — sessions, tasks,
   * attention, pins — lives inside its own state home and is not one of the five capabilities an
   * operator is asked about; a grant list that grew to cover every route would be a second copy of
   * the route table, and a second copy is how the two stop agreeing. What is NOT optional is the
   * answer: a route that names a capability cannot be served by a dispatcher with no guard.
   */
  readonly capability?: CapabilityDemand;
}

export interface ApiRoute extends ScopedRoute {
  /** Set when the response may carry credentials, working-tree bytes, or a live machine feed whose
   *  entire value is freshness. */
  readonly noStore?: boolean;
  handle(context: RouteContext): Promise<ApiResponse>;
}
