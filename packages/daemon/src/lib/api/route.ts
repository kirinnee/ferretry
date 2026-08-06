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
 * THIS IS ONE OF FOUR INDEPENDENT QUESTIONS, and they were once a single `scope` value that could only
 * ever answer whichever one its author had in mind:
 *
 * - **`minimum`** — the least CREDENTIAL CLASS that may reach the route. That is this type.
 * - **`privilegedOnly`** — whether the request must have ARRIVED over a privileged carrier, which is a
 *   fact about the transport and not about the token. See {@link ScopedRoute}.
 * - **`capability`** — what the OPERATOR must additionally have agreed the UI may do, consulted only
 *   after the two above pass, so a grant can never widen. See {@link ScopedRoute.capability}.
 * - **`wardenRemedy`** — which REMEDY the administrator has allowed a warden to exercise here, asked
 *   only of a caller whose token class is already `warden`. See {@link ScopedRoute.wardenRemedy}.
 *
 * THE FOUR ARE INDEPENDENT, AND KEEPING THEM SO IS THE POINT. Only the classes below form a ladder;
 * the other three questions sit beside it and beside each other. A warden permitted to exercise a
 * remedy has not thereby climbed toward `operator`, an admin token refused a remedy has not thereby
 * fallen below one, and neither answer moves the privileged-arrival flag. Any attempt to re-fold them
 * into one ordering would reproduce the exact defect `scope` was: a single value that answers whichever
 * question its author had in mind and silently guesses at the rest.
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
  /**
   * The remedy a WARDEN may exercise by reaching this route — the ADMINISTRATOR's answer, and a
   * question none of the three declarations above can be made to carry: the credential minimum is
   * about which class a caller holds, the privileged-arrival flag about where the request came from,
   * and the capability demand about what the machine's operator agreed the UI may do.
   *
   * ABSENT MEANS NO WARDEN MAY ACT HERE, which is why this is a declaration on the route rather than
   * a table somewhere else. Forgetting to think about it must mean "the warden cannot act", never
   * "the warden acts unchecked" — the same fail-closed direction the credential minimum takes, and for
   * the same reason: the source decided reachability in a chain of path patterns kept away from the
   * routes, so every subsystem that forgot to add itself became silently reachable.
   *
   * IT IS NOT A CREDENTIAL TIER. It neither raises nor lowers {@link ScopedRoute.minimum}, it says
   * nothing about {@link ScopedRoute.privilegedOnly}, and it is consulted only for a caller whose
   * SERVER-DERIVED token class is already `warden`. An admin or a paired device reaching a route that
   * declares one is governed by the minimum, the privileged-arrival flag and the operator grant
   * exactly as before, and this axis is not asked about them at all.
   *
   * THE VALUE IS OPAQUE HERE ON PURPOSE. The closed set of remedies belongs to the protocol, so that
   * every program that must agree about it reads one enumeration; a second four-member list written
   * beside this declaration would be that one fact acquiring a second owner. A consumer supplies the
   * protocol-owned value and the type narrows to it without this file changing shape.
   *
   * THE TYPE PROVES NOTHING ABOUT THE VALUE, so the boundary checks it. {@link WardenRemedyName} is
   * an alias for `string`: a route declaring `''` or `'   '` compiles exactly as well as one
   * declaring a real remedy, and it would otherwise reach the authorizer as a nameless question and
   * appear in a refusal as a gap in a sentence. A blank declaration is a wiring fault and is refused
   * for wardens, presented capability or not — the same answer a missing authorizer gets, for the
   * same reason.
   */
  readonly wardenRemedy?: WardenRemedyName;
}

/**
 * The name of a remedy, as a route declares it.
 *
 * Deliberately an alias rather than a union: the enumeration is protocol-owned (see
 * {@link ScopedRoute.wardenRemedy}) and this boundary must not become a second place that decides
 * which remedies exist. Narrowing the alias to the protocol type later is a one-line change here and
 * no change at all at any call site.
 *
 * IT IS PLAIN `string` AND CONSTRAINS NOTHING — not the membership of the set, and not even that a
 * name was written. Everything this alias cannot promise is checked where the value is used rather
 * than asserted where it is declared.
 */
export type WardenRemedyName = string;

/**
 * Everything the remedy authorizer is given about one warden request.
 *
 * NONE OF IT IS SELF-REPORTED EXCEPT THE CAPABILITY, WHICH IS EVIDENCE RATHER THAN A CLAIM. `remedy`
 * is what the ROUTE declared, so a caller cannot name its own. `actor` and the token class behind it
 * were derived from the presented credential, so the header can only ever refine WHICH warden is
 * acting and can never establish THAT one is. `capability` is a secret this daemon minted for one
 * assignment, so presenting it proves something.
 *
 * `remedy` and `capability` both arrive trimmed and nonblank because THE BOUNDARY CHECKS THEM, not
 * because either type says so: a blank secret is not a weaker answer but the absence of one, and a
 * blank declaration is not a quieter question but the absence of one. Neither ever reaches an
 * authorizer, so a policy never has to decide what a nameless remedy means.
 */
export interface WardenRemedyPresentation {
  /** The remedy THIS ROUTE declares, trimmed and never blank. Never a value read from the request. */
  readonly remedy: WardenRemedyName;
  /** The request as it arrived, so a policy can read the target it is about to affect. */
  readonly request: ApiRequest;
  /** Path parameters of the MATCHED route, RAW. Decode with `decodeParameter`. Passed so a policy
   *  reads its target from the routing decision rather than re-parsing a path this boundary has
   *  already inspected. */
  readonly params: RouteParameters;
  /** The per-assignment capability the warden presented, trimmed and never blank. */
  readonly capability: string;
  /** The server-derived actor, which names WHICH warden is acting. */
  readonly actor: ApiActor;
}

/**
 * What the remedy authorizer decided.
 *
 * A REFUSAL MUST CARRY ITS SENTENCE. A bare 403 tells a warden nothing it can act on, and the
 * authorizer is the only party that knows whether the missing piece is an administrator's setting,
 * the assignment it holds, or the target it aimed at.
 *
 * THE TYPE GETS THIS HALF RIGHT AND NO FURTHER. Making `refusal` part of the refused shape means an
 * authorizer cannot forget the field — but `string` admits `''`, and an empty sentence rendered into
 * a 403 is the opaque denial this shape exists to prevent, only harder to notice. So the boundary
 * treats a blank sentence as no decision at all and answers with its own, rather than passing an
 * empty explanation on to the warden.
 */
export type WardenRemedyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Names the configuration, credential or condition that would allow this remedy. A blank one
       *  is read as NO decision, never as a silent refusal. */
      readonly refusal: string;
    };

/**
 * The administrator's per-remedy answer, as the authorization boundary sees it.
 *
 * SYNCHRONOUS and STATELESS, exactly like the operator's guard beside it: this runs in front of every
 * request, so a boundary that awaited a read would put a new failure mode in front of a question that
 * must always have an answer. It holds no state across calls — everything it may consider arrives in
 * the presentation.
 *
 * Returning nothing is legal and means the daemon reached NO decision, which the boundary treats as a
 * refusal. An undetermined answer read as permission is the damaged-state-as-empty-state defect this
 * product has already been bitten by; the safe reading of "nobody can tell me" is "no".
 */
export interface WardenRemedyAuthorizer {
  decide(presentation: WardenRemedyPresentation): WardenRemedyDecision | undefined;
}

export interface ApiRoute extends ScopedRoute {
  /** Set when the response may carry credentials, working-tree bytes, or a live machine feed whose
   *  entire value is freshness. */
  readonly noStore?: boolean;
  handle(context: RouteContext): Promise<ApiResponse>;
}
