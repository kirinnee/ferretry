import type { ApiActor } from './actor.ts';
import type { CallerGovernance, CapabilityDemand } from './capability.ts';
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
 * - `none` — no token at all. Reserved for machine feeds and one-time-code redemption. ONE THING
 *   OVERRIDES IT, and it is visible here so a route author does not have to find it in the
 *   dispatcher: a route that ALSO declares {@link ScopedRoute.wardenRemedy} is not answered
 *   anonymously, because the shortcut that answers a public route is a shortcut past the remedy check
 *   too. Adding a remedy to a public route therefore turns it into an authenticated one; the two
 *   declarations together are almost certainly a mistake, and this is which way it fails.
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
  /**
   * The warden's authority to act HERE, minted by the remedy authorizer and present only when it
   * allowed the request. Server-derived exactly like `actor` and `credential`.
   *
   * A HANDLER CANNOT MINT ONE. That is the whole reason it travels on the context rather than being
   * re-derived downstream: a later step that needs to know it is running under a warden's authority —
   * to journal it, or to run the second half of a policy that only becomes decidable after an async
   * resolution — takes this value as an argument, and cannot be reached without the boundary having
   * said yes first.
   *
   * ABSENT IS THE ORDINARY CASE. Every operator, device and admin request has none, and its absence
   * means "not acting as a warden" rather than "acting as one, unrecorded".
   */
  readonly wardenRemedy?: WardenRemedyGrant;
  /**
   * Where this caller stands relative to the OPERATOR's gate — server-derived exactly like `actor`.
   *
   * PRESENT ON EVERY ROUTE THAT DECLARES A {@link ScopedRoute.capability}, and absent on every route
   * that does not, because a route the operator was never asked about has no answer here to give.
   *
   * A HANDLER CANNOT MINT ONE, and that is why it travels here rather than being re-derived. Both
   * facts it carries — whether the grants govern this caller, and whether this machine has an
   * operator password — are the boundary's, made from the transport's own account of where the socket
   * came from. A handler that recomputed either from `request.loopback` or from a token class would
   * be writing a second, quieter definition of locality, which is the failure this whole layer is
   * built to prevent. The fleet mount did exactly that in four places before this existed.
   *
   * IT ADDS A STEP AND NEVER REMOVES ONE. It is populated only for a request the capability demand
   * already allowed, so nothing read from it can serve a caller the boundary refused.
   */
  readonly governance?: CallerGovernance;
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
   * appear in a refusal as a gap in a sentence. A blank declaration is refused for wardens, presented
   * capability or not, under its own code — distinct from a missing authorizer, because a blank name
   * is a bug in this file and a missing authorizer is a bug in the wiring.
   *
   * THE ANSWER TRAVELS ONWARD. When the authorizer allows the request, its
   * {@link WardenRemedyGrant} is put on {@link RouteContext.wardenRemedy}, so a handler and anything
   * it calls act under an authority they could not have minted.
   *
   * NO SOCKET ROUTE IS EXPECTED TO DECLARE ONE. A remedy is a destructive action on a session and a
   * protocol switch is not one. The socket table is wired with the same authorizer regardless — a
   * boundary whose refusal named a fix nobody could perform would be worse than either a served route
   * or a declared prohibition — but the wiring is honesty, not an invitation.
   *
   * AND IT OVERRIDES `minimum: 'none'`: see {@link CredentialMinimum}. A public route that declares a
   * remedy stops being answerable anonymously.
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
 * Everything the remedy authorizer is given about one warden request — FOUR FIELDS, and the count is
 * the contract.
 *
 * EVERY FIELD A POLICY *CAN* READ IS A FIELD IT *MIGHT* DECIDE FROM, so this carries only what the
 * question consumes. It deliberately does NOT carry the request: the header map is the whole header
 * map, which would hand a policy object the caller's live bearer token and the operator's
 * five-minute unlock — a value whose own comment says it must never reach anywhere it can outlive
 * those five minutes — and would leave nothing stopping a `decide` from reading
 * `x-ferretry-session-id` and deciding from it, which is the header-movable authority this whole axis
 * exists to close. `method`, `path` and `loopback` are absent for a quieter reason: no conjunct needs
 * them. The route's identity already arrives as `remedy` — one remedy per route — and `loopback` is
 * the CARRIER's question, which {@link CapabilityDemand}'s guard already owns; giving it to an
 * administrator's policy would create a second, quieter definition of a question that has an answer.
 *
 * The one thing a policy might want and cannot have is the BODY. `decide` is synchronous and a body
 * read is not, so any fact that lives in a body — a migration's destination account, say — is not
 * decidable here and must be checked where it exists, after resolution and before the write.
 *
 * `remedy` and `capability` both arrive trimmed and nonblank because THE BOUNDARY CHECKS THEM, not
 * because either type says so: a blank secret is not a weaker answer but the absence of one, and a
 * blank declaration is not a quieter question but the absence of one. Neither ever reaches an
 * authorizer, so a policy never has to decide what a nameless remedy means.
 */
export interface WardenRemedyPresentation {
  /** The remedy THIS ROUTE declares, trimmed and never blank. Never a value read from the request. */
  readonly remedy: WardenRemedyName;
  /**
   * Path parameters of the MATCHED route, RAW. Decode with `decodeParameter`.
   *
   * THE TARGET LIVES HERE, and that it does is why this question is answerable at a synchronous
   * boundary at all: every route a warden may act on names its subject in the PATH, never in a body.
   */
  readonly params: RouteParameters;
  /**
   * The per-assignment capability the warden presented, trimmed and never blank.
   *
   * EVIDENCE, NOT YET A PROOF. This boundary has checked only that a nonblank string arrived; it has
   * NOT bound it to any assignment. A policy that reads only whether the remedy is enabled, and
   * assumes the boundary already tied this secret to a target, has skipped the conjunct that makes
   * the secret mean anything.
   */
  readonly capability: string;
  /**
   * The server-derived actor.
   *
   * ATTRIBUTION ONLY, and never an input to a decision. It may be the bare `warden` when no session
   * header was sent, which is exactly why WHICH warden is acting is answered by
   * {@link WardenRemedyGrant.wardenId} — resolved from the capability — rather than from here.
   */
  readonly actor: ApiActor;
}

/**
 * A warden's proven authority to exercise one remedy on one session.
 *
 * WHY IT IS A VALUE AND NOT A BOOLEAN. Two things need it later and neither can re-derive it. A
 * journal entry has to name WHICH warden acted, and the only unforgeable evidence of that is the
 * assignment secret that was presented — not `x-ferretry-session-id`, which any caller sets. And the
 * half of a policy that only becomes decidable after an async resolution has to take this as an
 * argument, so that half cannot be reached without this half having passed.
 *
 * ONLY THE AUTHORIZER MINTS ONE, and it does so from state, so a grant that exists is a grant whose
 * capability was matched to a live assignment.
 */
export interface WardenRemedyGrant {
  /** The remedy the route declared and the authorizer allowed. */
  readonly remedy: WardenRemedyName;
  /** The session this authority is over, read from the path. */
  readonly targetSessionId: string;
  /** WHICH warden — resolved from the presented capability, never from a header. */
  readonly wardenId: string;
  /** When the assignment behind the capability was created, so a journal entry can say which one. */
  readonly assignmentSpawnedAt: string;
}

/**
 * What the remedy authorizer decided.
 *
 * AN ALLOWANCE MUST NAME WHO IT IS FOR, and a refusal must carry its sentence. A bare `true` would
 * leave the destructive step downstream unable to say which warden it obeyed; a bare 403 tells a
 * warden nothing it can act on, and the authorizer is the only party that knows whether the missing
 * piece is an administrator's setting, the assignment it holds, or the target it aimed at.
 *
 * THE TYPE GETS THIS HALF RIGHT AND NO FURTHER. Making both fields part of their shapes means an
 * authorizer cannot forget either — but `string` admits `''`, and an empty sentence rendered into a
 * 403 is the opaque denial this shape exists to prevent, only harder to notice. So the boundary
 * treats a blank sentence, and a grant with a blank field or a remedy that disagrees with the route,
 * as no decision at all.
 */
export type WardenRemedyDecision =
  | {
      readonly allowed: true;
      /** The authority the handler and everything downstream act under. */
      readonly grant: WardenRemedyGrant;
    }
  | {
      readonly allowed: false;
      /** Names the configuration, credential or condition that would allow this remedy. A blank one
       *  is read as NO decision, never as a silent refusal. */
      readonly refusal: string;
    };

/**
 * The administrator's per-remedy answer, as the authorization boundary sees it.
 *
 * SYNCHRONOUS, like the operator's guard beside it: this runs in front of every request and every
 * socket upgrade, so a boundary that awaited a read would put a filesystem — and a brand new failure
 * mode — in front of a question that must always have an answer.
 *
 * ## IT IS NOT STATELESS, AND THE INVALIDATION CONTRACT IS THE LOAD-BEARING HALF
 *
 * The durable answer lives in a document and reading a document is asynchronous, so an implementation
 * MAY hold a snapshot — the operator's grant service already does exactly this, and it is safe
 * because of its refresh rule rather than in spite of holding state. The same rule is required here,
 * and it is a rule about a WRITE rather than a clock:
 *
 * - It **MUST** refresh its snapshot on every write to the warden runtime state document, ON THE SAME
 *   SERIALIZATION CHAIN that performs the write. There is exactly one writer and its writes are
 *   already serialized, so refresh-on-write closes the window EXACTLY rather than bounding it: an
 *   assignment stops authorizing at the same instant it stops existing. No polling and no TTL.
 * - It **MUST** answer `undefined` whenever its snapshot is absent or a refresh has failed. Anything
 *   else serves a decision that may no longer be true.
 *
 * Returning nothing is therefore legal AND required in those cases; the boundary reads it as a
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
