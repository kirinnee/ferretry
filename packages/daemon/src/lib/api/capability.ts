import type {
  CapabilityAxis,
  CapabilityGrants,
  DaemonCapability,
  EveryCallerStepUpAct,
  GrantRefusal,
  MachineSkippableStepUpAct,
  StepUpSubjectOf,
  StoredProofStepUpAct,
  StoredStepUpProof,
} from '@ferretry/protocol';
import type { ApiActor } from './actor.ts';
import type { SessionDevice } from './http.ts';

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
 * ## THE BOUNDARY IS ARRIVAL ON THE HOST
 *
 * Somebody on the machine already HAS the machine: they can edit the configuration document, run the
 * command line, or start anything they like. So the owner at the machine — the command line holding the admin token, over loopback — is
 * not governed by this layer at all (a browser on the host is a device like any other, B4), and a fresh install needs no setup and no questionnaire. See
 * `isGovernedCaller` for the whole rule.
 *
 * A governed caller exercising a dangerous demand must also hold a recent passkey step-up for its
 * proven device and app session (`StepUpWitness`). Every other restriction here exists for the caller who is NOT standing on the host, which is where a
 * boundary is real.
 *
 * ## "LOOPBACK" IS HOW THE REQUEST ARRIVED, NEVER WHAT IT CLAIMS
 *
 * This is the single detail that decides whether the design is sound rather than a hole. The relay
 * terminates ON this host, so a check that read a peer address, a `Host` header or a URL would see
 * loopback for a phone on the other side of the world and hand it the machine. `ApiRequest.loopback`
 * is therefore carrier-derived: the transport adapter sets it from the socket's real remote address,
 * and the relay tunnel sets it to `false` unconditionally, whatever address the hop appears to come
 * from. A loopback peer is still not the host — a locally bound proxy forwards remote callers from
 * one — so the presentation carries `arrivedOnHost`'s proof rather than `loopback` itself. Nothing in
 * this file re-derives it, and no header can move it.
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
  /**
   * The route only TAKES AWAY — revokes a plan line, deletes a 2FA key, a sign-in or an account, revokes or narrows a
   * device. The grant is still asked, and the unlock still stands, but never a per-act passkey step-up, whatever
   * "ask again for each act" says: taking access away is never harder than having it (docs/grants.md § Narrowing
   * never asks again). A route that can ALSO widen judges the widen inside, where a passkey proved for it is asked.
   */
  readonly narrowing?: true;
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
 * movable by a header. `stepUp` is this daemon's own record, keyed by the session's proven device,
 * so no header or body can move it either.
 */
export interface CapabilityPresentation {
  /** Whether the request is PROVED to come from this host (`arrivedOnHost`). Carrier-derived; a
   *  relayed hop and a proxied loopback peer never are. */
  readonly loopback: boolean;
  /**
   * Whether the caller authenticated with the HOST's own admin token.
   *
   * SERVER-DERIVED FROM THE TOKEN CLASS, never from `actor` — an actor string can be refined by a
   * self-identification header and is lossy about authority, so deriving a class back out of one would
   * be guessing at the very question this decides. Attribution and audit only; locality is `loopback`.
   */
  readonly adminToken: boolean;
  /** Who to attribute a change to. Attribution only — never an input to a decision. */
  readonly actor: ApiActor;
  /**
   * Whether the session's PROVEN device holds a live passkey step-up for its app session.
   *
   * Computed by the dispatcher from `ApiRequest.device` through a {@link StepUpWitness}; `false` for a
   * request with no proven device, which is every caller that is not a paired browser session —
   * including a remote warden, which is governed and can never step up.
   */
  readonly stepUp: boolean;
  /**
   * Whether that device proved a passkey FOR THIS ACT — within a challenge's lifetime and not yet spent
   * on another act that adds access. Only minting a pairing code and widening a device read it; the
   * unlock never makes it true. Absent reads as `false`.
   */
  readonly freshStepUp?: boolean;
  /**
   * The proven device's OWN grants, when the caller is a paired device; `null` when the session proved
   * a device this daemon no longer holds; absent for a caller that is not a device (the host's admin
   * token, a warden), which no device grant narrows.
   *
   * Read from this daemon's live device registry, keyed by the SESSION's proven device — never by a
   * header — so nothing a caller sends can move it.
   */
  readonly deviceGrants?: CapabilityGrants | null;
}

/** What the grant layer decided. The reason is not decoration — it is what names the next step. */
export interface GrantDecision {
  readonly allowed: boolean;
  readonly refusal: GrantRefusal;
  /**
   * Set on an ALLOWED decision that leaned on the caller's step-up, so the boundary can spend a
   * single-use one (a step-up window of `0`). Never set on a refusal.
   */
  readonly steppedUp?: true;
}

/**
 * WHERE THIS CALLER STANDS RELATIVE TO THE OPERATOR'S GATE, derived once by the boundary and handed
 * to a handler that has to honour or render it.
 *
 * IT EXISTS SO NO HANDLER RE-DERIVES ONE OF THESE. `governed` is `isGovernedCaller`'s answer for this
 * exact request, made from the facts the guard already gathered — and a handler that recomputed
 * it from `request.loopback` would be reading the ONE value that must never be inferred anywhere but
 * the transport, in the ONE place a mistake hands a remote phone the machine. The fleet mount used to
 * decide its own version of this from `tokenClass`, four separate times; that is the duplication this
 * type replaces.
 *
 * IT NEVER GRANTS ANYTHING. It arrives only on a request the capability demand already allowed, so a
 * handler reading it can add a step, never remove one.
 */
export interface CallerGovernance {
  /** Whether the operator's grants govern this caller at all. */
  readonly governed: boolean;
  /**
   * The operator's answer for ANY axis, for THIS caller — so a surface can report an axis its own
   * route did not demand.
   *
   * IT REPORTS AND NEVER ENFORCES. A read route asking "and would `configure` be allowed?" is exactly
   * how a panel explains a limit BEFORE somebody clicks into it, which is the whole requirement
   * `docs/grants.md` states for this layer. It is the same `decide` the boundary just used, bound to
   * the same presentation, so an answer here can never disagree with the enforcement beside it — and
   * it cannot widen anything, because reading a decision performs no act.
   */
  decide(demand: CapabilityDemand): GrantDecision;
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
   * Where this caller stands relative to the gate, for a handler that must honour or render it.
   *
   * SYNCHRONOUS and derived from the same evaluation `decide` uses, so a view can never disagree with
   * the enforcement it describes.
   */
  governance(presentation: CapabilityPresentation): CallerGovernance;
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
  // Every field the STRICTER reading: a table with no governed routes has no caller standing at this
  // gate, and a wiring mistake that grew one must not be told the caller is past it.
  governance: () => ({
    governed: true,
    decide: () => ({ allowed: false, refusal: 'undetermined' }),
  }),
  explain: () => undefined,
};

/**
 * The error code one refusal answers with.
 *
 * DISTINCT PER REASON, so a client can tell "the operator said no" from "confirm with your passkey" from
 * "this daemon has lost its own decision" without parsing prose. A single `forbidden` for all three
 * is what makes a UI grey a control out with nothing to say beside it.
 */
export function grantRefusalCode(refusal: GrantRefusal): string {
  return `grant_${refusal.replaceAll('-', '_')}`;
}

/**
 * Whether a session's proven device holds a live step-up. Synchronous, for the reason the guard is.
 *
 * DECLARED AT THE BOUNDARY so the dispatcher can compute `CapabilityPresentation.stepUp` without
 * importing the step-up subsystem; `StepUpService` satisfies it structurally.
 */
export interface StepUpWitness {
  held(subject: SessionDevice): boolean;
  /**
   * One act that needed the step-up was just admitted. Spends it when the machine asks every time;
   * absent on a witness whose step-ups are never single-use.
   */
  spend?(subject: SessionDevice): void;
  /**
   * Whether this device must confirm a person is present before it is served at all, on a machine that
   * asks for that on opening (`unlockOnOpen`, `docs/design/zero-trust.md` B6). Absent means it never
   * must. Asked of the same witness because a confirmation on opening is the same passkey ceremony,
   * verified by the same subsystem — and it never counts as a step-up.
   */
  unlockRequired?(subject: SessionDevice): boolean;
  /** Whether this device proved a passkey for the act at hand. Absent means it never has. */
  freshlyHeld?(subject: SessionDevice): boolean;
  /** Spends that proof. */
  spendFresh?(subject: SessionDevice): void;
  /**
   * Takes that proof atomically: of concurrent acts on one proof, exactly one is answered `true`. An act every caller
   * must prove names what its proof is bound to, and takes no other proof; no other claim takes one of its proofs.
   */
  claimFresh?: ClaimFreshWitness;
  /**
   * Takes the KEPT assertion of a passkey proved for a stored-proof act on exactly `stage`, once, while it is fresh, and
   * only when `expectedChallenge` is the challenge it was verified against — or nothing. Never a proof
   * {@link claimFresh} could take, and {@link claimFresh} never takes one of these.
   */
  claimStoredProof?<Act extends StoredProofStepUpAct>(
    subject: SessionDevice,
    act: Act,
    stage: StepUpSubjectOf<Act>,
    expectedChallenge: Uint8Array,
  ): StoredStepUpProof | undefined;
}

/** {@link StepUpWitness.claimFresh}, overloaded so an act every caller must prove cannot be asked the short way. */
export interface ClaimFreshWitness {
  (subject: SessionDevice, act?: MachineSkippableStepUpAct): boolean;
  (subject: SessionDevice, act: Exclude<EveryCallerStepUpAct, StoredProofStepUpAct>, bound: string): boolean;
}

/**
 * The witness for a dispatcher with no step-up subsystem wired: nobody holds a step-up, and nobody is
 * asked to unlock. FOR A SURFACE THAT SERVES NO DEVICE ONLY (a host-only table, a suite). It is open on
 * the unlock by construction (review R2-L2), so a dispatcher that serves paired devices must be given the
 * real step-up service. The mounted dispatchers are, by type: `MountedSubsystems.stepUp` is a
 * `StepUpService`, whose `unlockRequired` always exists, and `unlock-gate.test.ts` proves the mounted
 * route tables refuse a device before its unlock.
 */
export const NO_STEP_UP_WITNESS: StepUpWitness = { held: () => false };
