import type { CapabilityAxis, DaemonCapability, GrantRefusal } from '@ferretry/protocol';
import type { ApiActor } from './actor.ts';

/**
 * THE SECOND AUTHORIZATION QUESTION, asked after the first one has already been answered.
 *
 * A route's credential minimum and privileged-arrival declaration answer who may reach it at all;
 * they are the daemon's own contract. This answers something the OPERATOR decides for their machine:
 * *and of the things that credential could do, which have I agreed a caller who is NOT standing on
 * this host may do?* The layers are stacked, never merged — a grant is consulted only once both route
 * checks have passed,
 * and it can only ever remove what the scope already allowed.
 *
 * ## THE BOUNDARY IS LOOPBACK, WITH ONE GATE IN FRONT OF A LOCAL BROWSER
 *
 * Somebody on the machine already HAS the machine: they can edit the configuration document, run the
 * command line, or start anything they like. So the host's own command line is not governed by this
 * layer at all, and a fresh install needs no setup, no questionnaire and no password.
 *
 * A LOCAL BROWSER IS THE ONE EXCEPTION, because a browser is a paired device wherever it runs and an
 * unattended tab is one tap from provisioning the machine. It is governed until it presents an unlock
 * and ungoverned afterwards — one gate, then full authority, exactly as `sudo` behaves. That is
 * FRICTION AND NOT A BOUNDARY: a person at the keyboard can read the admin token and bypass it
 * entirely, so it buys deliberateness against slips and unattended tabs, and nothing here may claim it
 * stops an attacker with local access. See `isGovernedCaller` for the whole rule.
 *
 * Every other restriction here exists for the caller who is NOT standing on the host, which is where a
 * boundary is real.
 *
 * ## "LOOPBACK" IS HOW THE REQUEST ARRIVED, NEVER WHAT IT CLAIMS
 *
 * This is the single detail that decides whether the design is sound rather than a hole. The relay
 * terminates ON this host, so a check that read a peer address, a `Host` header or a URL would see
 * loopback for a phone on the other side of the world and hand it the machine. `ApiRequest.loopback`
 * is therefore carrier-derived: the transport adapter sets it from the socket's real remote address,
 * and the relay tunnel sets it to `false` unconditionally, whatever address the hop appears to come
 * from. Nothing in this file re-derives it, and no header can move it.
 *
 * The types live at the boundary rather than inside the subsystem that implements them, so the
 * dependency runs one way: the boundary declares what it needs to decide a request, and
 * `src/lib/grants` supplies it. The reverse — an authorization boundary importing a subsystem — is
 * how a route table ends up unable to be tested without building the daemon's whole world.
 */

/**
 * What one governed route demands.
 *
 * It travels WITH the route, exactly like `scope`, and for the same reason: a table of path patterns
 * kept somewhere else is a table every new subsystem has to remember to update, and the ones that
 * forget become silently reachable. A route that names no capability is not governed by this layer;
 * a route that names one cannot be served without an answer for it.
 */
export interface CapabilityDemand {
  readonly capability: DaemonCapability;
  /** `use` is exercising the capability; `configure` is changing how it behaves on the host. */
  readonly axis: CapabilityAxis;
}

/**
 * Everything about a caller the grant layer may consider.
 *
 * NONE OF IT COMES FROM A BODY, AND NONE OF IT IS SELF-REPORTED.
 *
 * `loopback` is the transport's own account of where the socket came from — see the header above for
 * why it may never be inferred from an address a caller presents. `actor` is the value
 * `resolveApiActor` already derived, carried only so a change can be journalled against whoever made
 * it; it never decides anything here, because a header can move it and this boundary must not be
 * movable by a header. `unlock` is a value this daemon minted itself and can therefore recognise on
 * its own evidence.
 */
export interface CapabilityPresentation {
  /** How the request ARRIVED. Carrier-derived; a relayed hop is never loopback. */
  readonly loopback: boolean;
  /**
   * Whether the caller authenticated with the HOST's own admin token.
   *
   * SERVER-DERIVED FROM THE TOKEN CLASS, never from `actor` — an actor string can be refined by a
   * self-identification header and is lossy about authority, so deriving a class back out of one would
   * be guessing at the very question this decides. It is here because arrival stopped being the whole
   * locality answer: a local BROWSER is a paired device and is gated, while the command line on the
   * same machine holds the token file and is not.
   */
  readonly adminToken: boolean;
  /** Who to attribute a change to. Attribution only — never an input to a decision. */
  readonly actor: ApiActor;
  /** An unlock presented for a `configure` demand. */
  readonly unlock?: string;
}

/** What the grant layer decided. The reason is not decoration — it is what names the next step. */
export interface GrantDecision {
  readonly allowed: boolean;
  readonly refusal: GrantRefusal;
}

/**
 * The grant layer as the authorization boundary sees it.
 *
 * SYNCHRONOUS, deliberately. This runs in front of every request and every socket upgrade, and a
 * boundary that awaited a disk read would put a filesystem — and a brand new failure mode — in front
 * of a question that must always have an answer.
 */
export interface CapabilityGuard {
  decide(demand: CapabilityDemand, presentation: CapabilityPresentation): GrantDecision;
  /**
   * The sentence a refused caller is shown, or nothing when there is nothing to explain.
   *
   * The GUARD composes it rather than the boundary, because a useful refusal names the command a
   * human runs next and the boundary has no business knowing what this product's client is called.
   * PR #284 established that a refusal naming the next step beats a bare denial; a greyed control
   * with no explanation is the dead end the owner has already complained about once.
   */
  explain(demand: CapabilityDemand, refusal: GrantRefusal): string | undefined;
}

/**
 * An explicit guard for a route table that names no capability demands.
 *
 * It still refuses if such a demand is added later: a table that outgrows this guard must wire the
 * real grants decision deliberately instead of silently acquiring an authorization bypass.
 */
export const NO_GOVERNED_ROUTES_GUARD: CapabilityGuard = {
  decide: () => ({ allowed: false, refusal: 'undetermined' }),
  explain: () => undefined,
};

/**
 * The error code one refusal answers with.
 *
 * DISTINCT PER REASON, so a client can tell "the operator said no" from "you need to unlock" from
 * "this daemon has lost its own decision" without parsing prose. A single `forbidden` for all three
 * is what makes a UI grey a control out with nothing to say beside it.
 */
export function grantRefusalCode(refusal: GrantRefusal): string {
  return `grant_${refusal.replaceAll('-', '_')}`;
}
