import {
  FY_VERSION_HEADER,
  OLDER_APP_SENTENCE,
  UNLOCK_REQUIRED_CODE,
  STEP_UP_REQUIRED_CODE,
  type StepUpAct,
  type StepUpRequiredBody,
  stepUpSkippableAtMachine,
} from '@ferretry/protocol';
import { type ApiActor, resolveApiActor, type TokenClass } from './actor.ts';
import {
  type ApiCredentials,
  type Authentication,
  authenticate,
  bearerToken,
  isPreKeyDeviceToken,
  isSessionCredential,
  type PresentedToken,
  presentToken,
  type SessionCredentialRefusal,
} from './authentication.ts';
import {
  type CallerGovernance,
  type CapabilityGuard,
  type CapabilityPresentation,
  grantRefusalCode,
  NO_STEP_UP_WITNESS,
  type StepUpWitness,
} from './capability.ts';
import type { LegacyWireUseRecorder } from '../legacy-wire/ports.ts';
import { ApiError } from './error.ts';
import {
  type ApiRequest,
  type ApiResponse,
  arrivedOnHost,
  arrivedPrivileged,
  headerValue,
  type RouteParameters,
} from './http.ts';
import { compressed, type ResponseCompressor } from './compression.ts';
import { errorResponse, jsonResponse, methodNotAllowedResponse, noStore, unknownRouteResponse } from './responses.ts';
import type {
  ApiRoute,
  ClaimFreshStepUp,
  RouteContext,
  ScopedRoute,
  WardenRemedyAuthorizer,
  WardenRemedyDecision,
  WardenRemedyGrant,
} from './route.ts';
import type { ApiRouter } from './router.ts';

/** The pane's own session id, so an in-pane caller is attributed to itself rather than to the
 *  shared token it holds. */
export const SESSION_ID_HEADER = 'x-ferretry-session-id';
/** Client self-identification (`cli`), which is what tells `admin-cli` from `admin-ui`. */
export const CLIENT_HEADER = 'x-ferretry-client';
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
  | {
      readonly kind: 'refused';
      readonly response: ApiResponse;
      /** Present when a session credential was refused for what it claimed — the dispatcher audits it. */
      readonly sessionRefusal?: SessionCredentialRefusal;
    }
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
 * way on both, and the `Authorization: Bearer` header — the only place a token is read from — is
 * honoured on identical terms.
 *
 * The order matters and differs from the source in one way worth naming. Unknown-route and
 * wrong-verb answers are produced only AFTER authentication succeeds, so an unauthenticated caller
 * cannot map the daemon's private surface by watching 404 turn into 405. Public routes are answered
 * before authentication is even attempted, because that is the whole point of being public. A public
 * route may still require loopback arrival, which the shortcut enforces itself; one that declares a
 * warden remedy is served the long way, because it asks for a check the shortcut would skip past.
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
 *
 * A FERRET SESSION'S CREDENTIAL is authenticated at step 1 and refused straight after it, on every route
 * this boundary authenticates: it names its own session, so `x-ferretry-session-id` naming another one is
 * `401 session_mismatch` (audited), and otherwise it is answered exactly as anonymous. The one route that
 * takes it (`POST /v1/agent/tools`) is public and reads it itself, so a session credential reaches nothing
 * it could not reach before — docs/agent-tools.md § "The ferret session credential". It is looked up only
 * when the request arrived on this machine's privileged loopback carrier: from anywhere else it is a
 * stranger's bearer, unasked about.
 */
/**
 * An app from before device keys redeeming a pairing code over plain HTTP.
 *
 * That route is deleted — redemption is a sealed record inside a session now — so nothing here serves
 * it. It is RECOGNISED only to be answered in words: an old app pairing with an updated machine would
 * otherwise be told `401`, which reads as "wrong code" to somebody whose only problem is an old app.
 */
const isPreKeyPairing = (request: ApiRequest): boolean => request.method === 'POST' && request.path === '/v1/pair';

export function authorizeRequest<TRoute extends ScopedRoute>(
  router: ApiRouter<TRoute>,
  credentials: ApiCredentials,
  request: ApiRequest,
  guard: CapabilityGuard,
  /**
   * The administrator's per-remedy answer, absent on a boundary that serves no remedy routes.
   *
   * OPTIONAL HERE, FAIL-CLOSED THERE: a table with no remedy declaration never consults it, and a
   * table that grows one and is served without an authorizer refuses every warden rather than
   * quietly acquiring a bypass — the same rule the capability guard already states for itself.
   */
  remedies?: WardenRemedyAuthorizer,
  /** Whose passkey step-up is live. Absent means nobody holds one, which can only refuse more. */
  stepUps: StepUpWitness = NO_STEP_UP_WITNESS,
  /**
   * What the session directory said about a session-shaped bearer ({@link presentedSession}), looked up
   * before this synchronous boundary. Absent is "not one, or names no active session": anonymous.
   */
  session?: PresentedToken['session'],
): RouteAuthorization<TRoute> {
  // A MEMBER IS REFUSED BY THE MAIN TABLE BEFORE ANYTHING ELSE, the public shortcut included: a member session
  // is served by the member route table alone, and an anonymous route here is still a route a member may not use.
  if (request.member !== undefined)
    return {
      kind: 'refused',
      response: errorResponse(403, `the request may not use ${request.method} ${request.path}`, 'forbidden'),
    };
  const lookup = router.lookup(request.method, request.path);
  // The public shortcut answers before authentication is even attempted, which is the whole point of
  // being public — but it is a shortcut past EVERY check below, so it may only be taken by a route
  // that asks for none of them. Privileged arrival is the one exception it can answer itself: a
  // public-but-local route remains anonymous on loopback, but refuses a remote caller before any
  // handler runs. A `none` route that also declared a warden remedy would be served to anyone at all,
  // remedy and authorizer unconsulted, which is the loudest possible version of the failure this axis
  // exists to prevent. Such a route is served the long way instead: authentication still refuses an
  // anonymous caller, and a warden still has to satisfy the remedy.
  if (lookup.kind === 'matched' && servedPublicly(lookup.route)) {
    if (lookup.route.privilegedOnly === true && request.privilegedLoopback !== true)
      return {
        kind: 'refused',
        response: errorResponse(403, `the request may not use ${request.method} ${request.path}`, 'forbidden'),
      };
    return { kind: 'authorized', route: lookup.route, context: { request, params: lookup.params } };
  }

  const bearer = bearerToken(headerValue(request, 'authorization'));
  // A DEVICE IS WHOEVER ITS SESSION PROVED, while its grant still exists, and only a session can say
  // so — the grant is re-read here so a request in flight on a revoked device's session is refused. `device` is set by the
  // tunnel that verified the key's signature over the session transcript, and by nothing else. A
  // session's request carries no `authorization` of its own (the tunnel's schema refuses one), so
  // there is no second credential here to disagree with it.
  const device = request.device;
  const presented: Authentication =
    device !== undefined
      ? credentials.devices?.has(device.deviceId) === true
        ? { kind: 'authenticated', tokenClass: 'device', deviceId: device.deviceId }
        : { kind: 'anonymous' }
      : authenticate(credentials, {
          ...(bearer === undefined ? {} : { bearer }),
          ...(session === undefined ? {} : { session }),
        });
  // THERE ARE NO SOCKET TICKETS ANY MORE. They existed so a browser — which cannot put a header on a
  // WebSocket — could authenticate an upgrade with a short-lived bearer value bought over HTTP. A
  // browser now opens every stream inside a session its device key opened, so no URL ever carries a
  // credential and there is nothing here to redeem one.
  const authentication = presented;
  if (authentication.kind === 'anonymous')
    return {
      kind: 'refused',
      // An app from before device keys still sends the bearer token it was given. Nothing can accept
      // that any more, and a bare 401 would read as "you were unpaired" when the truth is "update the
      // app" — so it is told which side is old, in the one sentence every surface shares.
      response:
        isPreKeyDeviceToken(bearer) || isPreKeyPairing(request)
          ? errorResponse(426, OLDER_APP_SENTENCE, 'app_outdated')
          : errorResponse(401, 'unauthorized', 'unauthorized'),
    };

  // A FERRET SESSION'S CREDENTIAL STOPS HERE, before the route is so much as named back to it. Its actor is
  // the session it was minted for, so a header naming any other session is a forged attribution — refused
  // and audited. Otherwise it is answered in a stranger's very words, so the answer says nothing about
  // whether the value is live: no route this boundary authenticates takes one yet, and widening that is a
  // per-route decision (`AuthenticatedCredential` keeps it out of handlers).
  if (authentication.tokenClass === 'session') {
    const claimed = headerValue(request, SESSION_ID_HEADER)?.trim() ?? '';
    if (claimed !== '' && claimed !== authentication.sessionId)
      return {
        kind: 'refused',
        response: errorResponse(
          401,
          `this session credential names its own session, and ${SESSION_ID_HEADER} names a different one; drop the header — the daemon reads who you are from the credential`,
          'session_mismatch',
        ),
        sessionRefusal: {
          reason: 'session_mismatch',
          sessionId: authentication.sessionId,
          route: `${request.method} ${request.path}`,
        },
      };
    return { kind: 'refused', response: errorResponse(401, 'unauthorized', 'unauthorized') };
  }

  if (lookup.kind === 'not-found') return { kind: 'unrouted' };
  if (lookup.kind === 'method-not-allowed')
    return {
      kind: 'refused',
      response: methodNotAllowedResponse(request.method, request.path, lookup.allowed),
    };

  // The OWNER is the host's admin token over loopback, never a loopback peer on its own: a tunnel or
  // proxy to 127.0.0.1 is a loopback peer too. A `privilegedOnly` route asks the separate question of
  // where the request arrived, which a local browser on a loopback-only bind also answers.
  const onHost = arrivedOnHost(request, authentication.tokenClass === 'admin');
  if (
    !meetsMinimum(authentication.tokenClass, lookup.route.minimum) ||
    (lookup.route.privilegedOnly === true && !arrivedPrivileged(request, authentication.tokenClass === 'admin'))
  )
    return {
      kind: 'refused',
      response: errorResponse(
        403,
        `the presented credential may not use ${request.method} ${request.path}`,
        'forbidden',
      ),
    };

  // A MACHINE THAT WANTS A PERSON ON OPENING serves a device nothing until one has confirmed. The
  // session is sound, so this is 401 rather than a refusal of the device, and the few routes a device
  // needs to GIVE that confirmation are exempt. Asked only of a proven device: the CLI and a warden
  // have no passkey to give. `onHost` is the owner's admin token over loopback, which no device holds,
  // so every browser is asked — the machine itself, through `fy`, is the way back in (B4).
  if (
    device !== undefined &&
    !onHost &&
    lookup.route.unlockExempt !== true &&
    stepUps.unlockRequired?.(device) === true
  )
    return {
      kind: 'refused',
      response: errorResponse(
        401,
        'this machine asks you to confirm it is you with a passkey before it shows anything',
        UNLOCK_REQUIRED_CODE,
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
  let governance: CallerGovernance | undefined;
  // Built for EVERY authenticated route, governed or not, so a handler that asks one more grant
  // question (the grant and device-grant surfaces) reads the boundary's facts rather than re-deriving them.
  const presentation: CapabilityPresentation = {
    // The CARRIER's proof, never a header's. A relayed hop terminates on this very host and a
    // locally bound proxy forwards from a loopback peer, so anything derived from an address would
    // read as local and hand a remote caller the machine.
    loopback: onHost,
    // The AUTHENTICATED class, not the actor beside it: the actor is refined by self-identification
    // headers and would make this decision movable by a header. Attribution only.
    adminToken: authentication.tokenClass === 'admin',
    actor,
    // The SESSION's proven device, never a header's claim. No device — a bearer caller, a warden —
    // holds no step-up and never can.
    stepUp: request.device !== undefined && stepUps.held(request.device),
    freshStepUp: request.device !== undefined && stepUps.freshlyHeld?.(request.device) === true,
    // The SESSION's proven device's own grants, from the live registry. `null` for a device that was
    // admitted but is gone, so it is refused rather than served unnarrowed.
    ...(authentication.tokenClass === 'device'
      ? { deviceGrants: credentials.devices?.grants?.(authentication.deviceId) ?? null }
      : {}),
  };
  if (demand !== undefined) {
    const decision = guard.decide(demand, presentation) ?? { allowed: false, refusal: 'undetermined' as const };
    if (!decision.allowed) {
      const message =
        guard.explain(demand, decision.refusal) ??
        `this daemon cannot say whether the UI may use ${demand.capability}, so it is refusing`;
      const code = grantRefusalCode(decision.refusal);
      return {
        kind: 'refused',
        // A step-up refusal ALSO names the demand, so the app can tell the person which act they are
        // confirming. Only the closed pair: nothing taken from the request is ever echoed.
        response:
          decision.refusal === 'step-up-required'
            ? jsonResponse(
                {
                  error: message,
                  code: STEP_UP_REQUIRED_CODE,
                  demand: { capability: demand.capability, axis: demand.axis },
                } satisfies StepUpRequiredBody,
                403,
              )
            : errorResponse(403, message, code),
      };
    }

    // A step-up the machine wants asked for every time is good for this one act and no other. Spent
    // here, at the decision, so a second request cannot ride the confirmation the first one bought.
    if (decision.steppedUp === true && request.device !== undefined) stepUps.spend?.(request.device);
    // Derived AFTER the refusal, so it can only ever describe a request this daemon is about to
    // serve. A handler is given where the caller stands so it can ask for one more thing; it is
    // never given a way to conclude that a refused caller was allowed.
    governance = guard.governance(presentation);
  }
  const remedy = wardenRemedyOutcome(lookup.route, authentication.tokenClass, request, lookup.params, actor, remedies);
  if (remedy.kind === 'refused') return { kind: 'refused', response: remedy.response };
  return {
    kind: 'authorized',
    route: lookup.route,
    context: {
      request,
      params: lookup.params,
      actor,
      credential: authentication,
      // Present only when a warden was allowed one, so its ABSENCE means "not acting as a warden"
      // rather than "acting as one, unrecorded".
      ...(remedy.kind === 'granted' ? { wardenRemedy: remedy.grant } : {}),
      // Present only where the route named a capability, so its ABSENCE means "the operator was never
      // asked about this route" rather than "asked, and the answer was mislaid".
      ...(governance === undefined ? {} : { governance }),
      presentation,
      spendStepUp: () => {
        if (request.device !== undefined) stepUps.spend?.(request.device);
      },
      spendFreshStepUp: () => {
        if (request.device !== undefined) stepUps.spendFresh?.(request.device);
      },
      claimFreshStepUp: claimFreshStepUp(request.device, stepUps),
    },
  };
}

/**
 * A route's claim on the caller's fresh proof. An act asked of EVERY caller binds its proof to one subject, and this
 * daemon mints no such proof yet (step-up options for one are refused), so nothing satisfies it, whoever asks, the
 * machine included, and a proof minted for anything else is never spent on it. The subject-bound claim lands with the
 * staged save.
 */
function claimFreshStepUp(device: RouteContext['request']['device'], stepUps: StepUpWitness): ClaimFreshStepUp {
  return (act?: StepUpAct, _subject?: string): boolean => {
    if (act !== undefined && !stepUpSkippableAtMachine(act)) return false;
    return device !== undefined && stepUps.claimFresh?.(device, act) === true;
  };
}

/**
 * Whether a route is served before authentication is attempted — the public shortcut. One that declares
 * a warden remedy is not: it asks for a check the shortcut would skip past.
 */
const servedPublicly = (route: ScopedRoute): boolean => route.minimum === 'none' && route.wardenRemedy === undefined;

/**
 * The asynchronous half of authentication: what the session directory says about a session-shaped bearer.
 *
 * Asked ONLY where the boundary will authenticate — never for a public route, which reads whatever
 * credential it takes itself (the agent tools do, through this same directory), so one request is looked
 * up once. Never for a device's session or a member's either: neither carries a bearer of its own.
 *
 * ONLY FOR A REQUEST THAT ARRIVED ON THIS MACHINE'S PRIVILEGED LOOPBACK CARRIER. A pane presents its
 * credential from this host and from nowhere else, so a session-shaped bearer from a remote carrier — the
 * tunnel listener, a LAN bind — is a stranger's, answered from its shape: it costs no session reads, and
 * says nothing about whether a leaked value is still live.
 */
export async function presentedSession<TRoute extends ScopedRoute>(
  router: ApiRouter<TRoute>,
  credentials: ApiCredentials,
  request: ApiRequest,
): Promise<PresentedToken['session']> {
  if (request.privilegedLoopback !== true || request.device !== undefined || request.member !== undefined)
    return undefined;
  const bearer = bearerToken(headerValue(request, 'authorization'));
  if (!isSessionCredential(bearer)) return undefined;
  const lookup = router.lookup(request.method, request.path);
  if (lookup.kind === 'matched' && servedPublicly(lookup.route)) return undefined;
  return (await presentToken(credentials, bearer)).session;
}

/** Tells the audit log about a refused session credential. A write that fails never changes the answer. */
export async function recordSessionRefusal(
  credentials: ApiCredentials,
  refusal: SessionCredentialRefusal | undefined,
): Promise<void> {
  if (refusal === undefined) return;
  try {
    await credentials.sessions?.refused?.(refusal);
  } catch {
    // The audit log reports its own failures; a refusal is answered either way.
  }
}

/** What the remedy axis had to say about one request: nothing, a proven authority, or a refusal. */
type WardenRemedyOutcome =
  | { readonly kind: 'absent' }
  | { readonly kind: 'granted'; readonly grant: WardenRemedyGrant }
  | { readonly kind: 'refused'; readonly response: ApiResponse };

/**
 * The ADMINISTRATOR's answer, asked last and only of a warden.
 *
 * THE FIRST LINE IS THE WHOLE SECURITY PROPERTY. The token class decides who is subject to this
 * question, and the token class is what the presented credential proved — so an admin or a device
 * that carries {@link WARDEN_CAPABILITY_HEADER} is simply not asked, keeps the authority its own
 * class already earned, and keeps its own attribution. The header cannot promote a caller INTO this
 * check and cannot excuse a caller out of the checks above it.
 *
 * Every path back out of here is `absent` — this axis has nothing to say — a `granted` authority the
 * request carries onward, or a 403 that names what would allow the operation UNDER ITS OWN CODE. A
 * denial that says only "forbidden" is a dead end, and so is one code covering every cause: a missing
 * setting, a missing capability, a blank declaration, an unwired boundary and a daemon that lost its
 * own state have five different next steps and, between them, three different people to fix them.
 */
function wardenRemedyOutcome(
  route: ScopedRoute,
  tokenClass: TokenClass,
  request: ApiRequest,
  params: RouteParameters,
  actor: ApiActor,
  remedies: WardenRemedyAuthorizer | undefined,
): WardenRemedyOutcome {
  if (tokenClass !== 'warden') return { kind: 'absent' };
  const capability = headerValue(request, WARDEN_CAPABILITY_HEADER)?.trim() ?? '';
  const declared = route.wardenRemedy;
  if (declared === undefined) {
    // A route that declares no remedy is one no warden may act on. Serving the request anyway
    // because the header "did not apply" is how forgetting to declare would come to mean unchecked.
    if (capability === '') return { kind: 'absent' };
    return refusal(
      `${request.method} ${request.path} declares no warden remedy, so a warden capability cannot authorize it; drop ${WARDEN_CAPABILITY_HEADER} and use a credential that may reach this route on its own`,
      'warden_remedy_undeclared',
    );
  }
  const remedy = declared.trim();
  // Three failures, three owners, three codes. A blank name is a bug in the route table, an absent
  // authorizer is a bug in the wiring, and a decisionless authorizer is a daemon that has lost its
  // own state — and the client rendering these into something a human acts on must be able to tell
  // them apart without reading the prose.
  if (remedy === '')
    return refusal(
      `${request.method} ${request.path} declares a blank warden remedy, so this daemon cannot say what a warden would be doing here and is refusing; the route must name the remedy it means`,
      'warden_remedy_invalid',
    );
  if (capability === '')
    return refusal(
      `a warden may ${remedy} here only by presenting the capability of the assignment it was given, in ${WARDEN_CAPABILITY_HEADER}`,
      'warden_capability_required',
    );
  if (remedies === undefined)
    return refusal(
      `this daemon was built with no warden remedy authorizer, so it cannot say whether a warden may ${remedy} here and is refusing; the route declares a remedy and the boundary serving it must be wired with one`,
      'warden_remedy_unwired',
    );
  const decision = remedies.decide({ remedy, params, capability, actor });
  if (decision === undefined || (!decision.allowed && decision.refusal.trim() === '') || unusable(decision, remedy))
    // A refusal with nothing to say is not a quieter refusal, it is an unfinished one, and an
    // allowance that names no warden is an authority nothing downstream can journal. Both are read as
    // no decision, and the boundary says what it can say on its own rather than rendering a gap.
    return refusal(
      `this daemon reached no decision about whether a warden may ${remedy} here, so it is refusing; an administrator must allow this remedy for the assignment that was given`,
      'warden_remedy_undetermined',
    );
  return decision.allowed
    ? { kind: 'granted', grant: decision.grant }
    : refusal(decision.refusal.trim(), 'warden_remedy_refused');
}

const refusal = (message: string, code: string): WardenRemedyOutcome => ({
  kind: 'refused',
  response: errorResponse(403, message, code),
});

/**
 * Is an ALLOWANCE too damaged to act on?
 *
 * A grant is the evidence a destructive step names its warden by, so a blank field in one is not a
 * smaller grant — it is a grant that cannot do the one job it exists for. A remedy that disagrees
 * with the route's is worse: an authority minted for a different question.
 */
function unusable(decision: WardenRemedyDecision, remedy: string): boolean {
  if (!decision.allowed) return false;
  const { grant } = decision;
  return (
    grant.remedy !== remedy ||
    grant.targetSessionId.trim() === '' ||
    grant.wardenId.trim() === '' ||
    grant.assignmentSpawnedAt.trim() === ''
  );
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
    /** Whose passkey step-up is live. Absent on a table that wires no step-up subsystem. */
    private readonly stepUps?: StepUpWitness,
    /** Where a request that reached a `legacy: true` route is counted. Absent where nothing counts. */
    private readonly legacyUse?: LegacyWireUseRecorder,
    /** Where a large `GET` answer is gzipped. Absent where nothing compresses (tests, tables that serve no list). */
    private readonly compressor?: ResponseCompressor,
  ) {}

  async dispatch(request: ApiRequest): Promise<ApiResponse> {
    const authorized = authorizeRequest(
      this.router,
      this.credentials,
      request,
      this.guard,
      this.remedies,
      this.stepUps,
      await presentedSession(this.router, this.credentials, request),
    );
    if (authorized.kind === 'unrouted') return unknownRouteResponse(request.method, request.path);
    if (authorized.kind === 'refused') {
      await recordSessionRefusal(this.credentials, authorized.sessionRefusal);
      return authorized.response;
    }
    if (authorized.route.legacy === true) this.#countLegacyUse(authorized.route, request);
    const response = await run(authorized.route, authorized.context);
    return await compressed(request, response, this.compressor, authorized.route.compress === true);
  }

  /** Counted only once the caller is authorized, so a probe of an older route is not "a client still uses it". */
  #countLegacyUse(route: ApiRoute, request: ApiRequest): void {
    try {
      const version = headerValue(request, FY_VERSION_HEADER);
      this.legacyUse?.record({
        route: `${route.method} ${route.path}`,
        ...(version === undefined ? {} : { clientVersion: version }),
      });
    } catch {
      // The counter is a measurement; it never fails the request it measures.
    }
  }
}

/** How a route that threw is answered: a refusal it named keeps its own status; anything else is a bare 500. */
const failed = (error: unknown): ApiResponse =>
  error instanceof ApiError
    ? errorResponse(error.status, error.message, error.code, error.extra)
    : errorResponse(500, 'the daemon failed to handle this request', 'internal_error');

async function run(route: ApiRoute, context: RouteContext): Promise<ApiResponse> {
  const policy = (response: ApiResponse): ApiResponse => (route.noStore === true ? noStore(response) : response);
  let built: ApiResponse;
  try {
    built = await route.handle(context);
  } catch (error) {
    return policy(failed(error));
  }
  const spell = built.late;
  if (spell === undefined) return policy(built);
  // The body is spelled again here, after the route's last await, and its last word travels on with the
  // response: every carrier calls it (`finalised`) as the final synchronous step before the bytes leave.
  const last = (): ApiResponse => {
    try {
      return policy(spell());
    } catch (error) {
      return policy(failed(error));
    }
  };
  return { ...last(), late: last };
}
