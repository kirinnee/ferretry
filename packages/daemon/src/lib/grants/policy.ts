import {
  type CapabilityAxis,
  type CapabilityGrant,
  type CapabilityGrants,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  GRANT_UNLOCK_LOCKOUT_SECONDS,
  GRANT_UNLOCK_MAX_ATTEMPTS,
  type GrantRefusal,
  type GrantsPatch,
} from '@ferretry/protocol';
import type { CapabilityDemand, GrantDecision } from '../api/capability.ts';
import type { EnforcedGrants } from './types.ts';

/**
 * The product's answers when an operator has not given their own.
 *
 * PERMISSIVE, and chosen rather than shrugged at. The governing principle is *control as much as
 * possible from the UI, with a security layer for the cautious* — so a person should be able to do
 * everything from a browser until they decide otherwise, and the restriction is something they turn
 * on rather than a wall they start behind. Both axes are therefore enabled for all six capabilities,
 * `pairing` included — see `docs/grants.md` for why the one that hands out credentials needs no
 * exception: a caller who is not on this host can switch it off and can never switch it back on.
 *
 * THE PRIMARY SECURITY LAYER IS LOCALITY, NOT THE PASSWORD. A remote caller can never turn a
 * capability ON — not with the operator password, not with a valid unlock, not ever. Widening is a
 * local act, so the dangerous half of this model is structurally unavailable to a stolen phone and
 * the worst it can do is narrow the machine own permissions. Starting open therefore costs far less
 * than it would if a remote caller could grant itself things.
 *
 * THE OPERATOR PASSWORD IS A SECOND, OPTIONAL LOCK, and only over remote CONFIGURE. A cautious
 * operator sets one and every configure demand from off the host then needs an unlock; an operator
 * who wants none is not obstructed. It is no longer what stands between a remote caller and widening
 * — nothing needs to, because there is no remote path to widening at all.
 *
 * WHAT THIS DOES NOT REDUCE, and the honest thing to say about these defaults: locality bounds what a
 * remote caller may GRANT, and says nothing about what an already-granted capability may DO.
 * `terminal.use` is arbitrary code on the host, and `fleet.use` composes changes that write
 * executables. A paired device is trusted with those by default, so pairing — not this layer — is
 * where that decision is actually made.
 */
export const DEFAULT_CAPABILITY_GRANTS: CapabilityGrants = {
  fleet: { use: true, configure: true },
  terminal: { use: true, configure: true },
  browser: { use: true, configure: true },
  filesystem: { use: true, configure: true },
  warden: { use: true, configure: true },
  pairing: { use: true, configure: true },
};

/**
 * What a person is told, once, when this machine has no operator password.
 *
 * ONE SENTENCE, WHERE THE DECISION IS. Not a modal, not a recurring warning, and not a question at
 * install time — somebody using their own machine over loopback is affected by none of this and must
 * not be interrogated about it. It belongs where remote access is actually being arranged or
 * inspected: the grant report, and the moment a device is paired. Somebody who has decided how their
 * own machine works is owed the truth about it and then left alone; nagging teaches people to dismiss
 * the daemon's output, which costs more than the warning is worth.
 */
export const NO_PASSWORD_DISCLOSURE =
  'no operator password is set, so any paired device can change the settings of whatever is already turned on here — it still cannot turn anything on, which only this machine can do';

/**
 * Everything the governance question reads about ONE caller. None of it is self-reported.
 *
 * `loopback` is the transport's own account of where the socket came from. `adminToken` is the
 * SERVER-DERIVED token class, not an actor string — an actor can be refined by a header and is lossy
 * about authority, and this decision must not be movable by a header. The other two are this daemon's
 * own state and its own minted unlocks.
 */
export interface CallerArrival {
  /** How the request ARRIVED. Carrier-derived; a relayed hop is never loopback. */
  readonly loopback: boolean;
  /** Whether the caller authenticated with the HOST's own admin token — never a device, never a warden. */
  readonly adminToken: boolean;
  /** Whether this machine has an operator password at all. */
  readonly passwordSet: boolean;
  /** Whether the caller presented an unlock this daemon minted and that has not expired. */
  readonly unlockHeld: boolean;
}

/**
 * Whether the operator's grants govern THIS caller.
 *
 * ## ONE GATE AT THE DOOR, THEN FULL AUTHORITY
 *
 * Arrival on the host is no longer the whole answer, and the reason is that a BROWSER IS A PAIRED
 * DEVICE WHEREVER IT RUNS. A tab left open on an unattended desk was one tap from provisioning the
 * machine, so a local browser is governed by everything below until it presents an unlock and
 * ungoverned — completely, with no second gate and no per-action prompt — once it has. That is what
 * `sudo` provides.
 *
 * IT IS FRICTION, NOT A BOUNDARY, and this file will not pretend otherwise. Somebody at the keyboard
 * can open a terminal, read the admin token and do all of it anyway. What the gate buys is that a
 * destructive change is deliberate rather than accidental: it defends against a slip, casual misuse
 * and an unattended tab. It does not defend against a person with local access, and no comment or
 * sentence anywhere may claim it does.
 *
 * ## TWO CALLERS ARE UNGOVERNED ON ARRIVAL, AND BOTH ARE LOAD-BEARING
 *
 * - **The host's own admin token.** Reading that file already requires being on the machine, so gating
 *   it would add friction with no safety — and it would close the one door a FORGOTTEN password can
 *   still be repaired through. `fy daemon password set` must always work without the old password;
 *   that escape hatch is why a local browser gate cannot brick a machine, and it must never close.
 * - **A machine with no password.** There is nothing to unlock with and no gate to pass, so a fresh
 *   install is useful immediately and nobody is asked to invent a secret before their first run. The
 *   first password is set when the first device is paired, which is where remote access begins.
 *
 * ## EVERY OTHER RESTRICTION IN THIS FILE IS FOR THE CALLER WHO IS NOT ON THE HOST
 *
 * A paired phone, a browser across the network, a session carried over the rendezvous. That is where a
 * boundary is real, because possession of the machine is exactly what such a caller does not have.
 *
 * THE ARRIVAL VALUE MUST BE CARRIER-DERIVED, and it is: the transport adapter sets
 * `ApiRequest.loopback` from the socket's actual remote address, and the relay tunnel — which
 * terminates on this very host — sets it to `false` unconditionally, whatever address the hop appears
 * to carry. Deciding this from a peer address, a `Host` header or a URL containing `127.0.0.1` would
 * hand a remote phone the machine, and that is the worst bug this design could produce. Nothing here
 * re-derives it.
 */
export function isGovernedCaller(arrival: CallerArrival): boolean {
  if (!arrival.loopback) return true;
  if (arrival.adminToken) return false;
  if (!arrival.passwordSet) return false;
  return !arrival.unlockHeld;
}

/**
 * Whether a change this caller makes must be confirmed against the operator password, PER CHANGE.
 *
 * ## IT IS NOT A SECOND CREDENTIAL SYSTEM, AND THE FLEET'S OLD ONE WAS
 *
 * The fleet used to answer this question itself: an eight-character code the host minted for one
 * proposal, living 120 seconds, with five wrong tries of its own. Two rate limiters, two lifetimes,
 * two secret grammars, two refusal vocabularies, one question. What is here instead adds no secret,
 * no lifetime and no budget — it is the SAME operator password, proved again, against one exact
 * staged artifact, spending the same five tries the unlock does.
 *
 * ## WHAT IT BUYS, STATED NARROWLY
 *
 * An unlock is a bearer token with a five-minute life, and `decideCapability` accepts it for any
 * number of `configure` demands inside that window. This says: for a change that writes executable
 * files into somebody's home, the window is not enough — the password itself must be presented with
 * the change. So a borrowed or replayed unlock cannot by itself provision a host.
 *
 * It buys nothing against a caller that holds the password, and it does not claim to. §6 of
 * `docs/design/fleet-authority-unification.md` records what it cannot carry: the deleted code proved
 * a HUMAN was at a terminal, and no secret can prove that, because a secret in a config file is
 * exactly what a script has.
 *
 * ## AND NOTHING AT ALL WHERE THERE IS NO PASSWORD
 *
 * A machine with none has no secret to bind a change to, so there is deliberately no prompt. A
 * control that cannot refuse is theatre, and this codebase requires a refusal to name a remedy a
 * person can actually perform (see {@link describeGrantRefusal}). An UNGOVERNED caller is asked for
 * nothing either: that is the host's own command line, and a browser on this machine that has already
 * unlocked — the sudo shape `isGovernedCaller` establishes, one gate and then full authority.
 */
export function requiresChangeConfirmation(arrival: Pick<CallerArrival, 'passwordSet'>, governed: boolean): boolean {
  return governed && arrival.passwordSet;
}

/**
 * Whether this caller may set, replace or clear the operator password.
 *
 * THE SAME QUESTION AS "is this caller ungoverned", delegated rather than restated so the two answers
 * cannot drift: the password is the thing the gate is made of, and a caller who is already past the
 * gate is the only one who may move it. It resolves to the three cases that matter — the host's admin
 * token always may (the escape hatch), a local browser may once it has unlocked, and a machine with no
 * password yet may set the first one — while a remote caller never does, which the route's
 * `privilegedOnly` declaration has already refused before this is asked.
 */
export function mayChangeOperatorPassword(arrival: CallerArrival): boolean {
  return !isGovernedCaller(arrival);
}

/** Everything the per-request decision reads, gathered so none of it comes from a global. */
export interface GrantEvaluation {
  readonly grants: EnforcedGrants;
  /** Whether a cautious operator has turned the security layer on at all. */
  readonly passwordSet: boolean;
  /** Whether the caller presented an unlock this daemon minted and has not expired. */
  readonly unlockHeld: boolean;
  /** Set while the daemon is refusing to check passwords at all. */
  readonly rateLimited: boolean;
  /** Whether the operator's grants apply to this caller at all. See {@link isGovernedCaller}. */
  readonly governed: boolean;
  /**
   * Whether the request ARRIVED on this host — the locality fact, kept separate from `governed`.
   *
   * The two came apart when a local browser stopped being ungoverned on arrival, and they must stay
   * apart: locality is what decides whether a capability can ever be turned back ON, and reading that
   * off `governed` would tell somebody standing at the machine that a switch is a one-way door merely
   * because they have not typed the password yet.
   */
  readonly hostLocal: boolean;
}

/**
 * The one decision, and the only place authority is ever removed.
 *
 * IT NEVER GRANTS. Every branch either keeps the answer the route's scope check already produced —
 * because this caller is ungoverned, or because the operator said yes — or removes it. There is
 * deliberately no input that turns a refused route into a served one, which is what makes "a grant
 * can only narrow" a property of the code rather than a promise in a document.
 *
 * `configure` IMPLIES `use`. A capability the UI may not exercise but may reconfigure is incoherent:
 * it would let a browser change how a shell spawns on the host while being unable to open one.
 */
export function decideCapability(demand: CapabilityDemand, evaluation: GrantEvaluation): GrantDecision {
  if (!evaluation.governed) return { allowed: true, refusal: 'granted' };
  const grants = evaluation.grants;
  // Not "assume the benign reading": a daemon that cannot say what it is enforcing enforces nothing.
  // Permissive defaults settle what SILENCE means, never what damage means.
  if (grants === undefined) return { allowed: false, refusal: 'undetermined' };
  const grant = grants[demand.capability];
  if (!grant.use) return { allowed: false, refusal: 'not-granted' };
  if (demand.axis === 'use') return { allowed: true, refusal: 'granted' };
  if (!grant.configure) return { allowed: false, refusal: 'not-granted' };
  // No password means the operator declined the security layer for this machine, and they were told
  // in one sentence what that meant. It is reported as `ungated` rather than `granted` so the answer
  // carries WHY it passed — a UI can then say once, beside the control, that nothing is standing
  // behind it. Silently returning `granted` would make a machine with a password and a machine
  // without one indistinguishable to everything downstream.
  if (!evaluation.passwordSet) return { allowed: true, refusal: 'ungated' };
  if (evaluation.rateLimited) return { allowed: false, refusal: 'rate-limited' };
  if (!evaluation.unlockHeld) return { allowed: false, refusal: 'locked' };
  return { allowed: true, refusal: 'granted' };
}

/** The capability name as an operator reads it, so a refusal names a thing rather than a key. */
const CAPABILITY_NOUNS: Readonly<Record<DaemonCapability, string>> = {
  fleet: 'the agent fleet',
  terminal: 'session terminals',
  browser: 'the browser',
  filesystem: 'the project filesystem',
  warden: 'fleet supervision',
  pairing: 'device pairing',
};

/** The capability as an operator reads it, for a report row or a refusal. */
export function capabilityNoun(capability: DaemonCapability): string {
  return CAPABILITY_NOUNS[capability];
}

/**
 * The sentence a refused caller is shown.
 *
 * EVERY BRANCH NAMES THE NEXT STEP. A denial that says only "forbidden" is the dead end the owner has
 * already complained about once: the person is left guessing whether they mis-typed something, need
 * a password, or are looking at a decision somebody made on purpose. `clientName` is threaded in so
 * the message names the command a human actually runs rather than one this file invents.
 *
 * The two ALLOWED reasons return nothing. A caller that was served needs no explanation, and
 * `ungated` is a disclosure the grant VIEW carries rather than something to attach to a success.
 */
export function describeGrantRefusal(
  demand: CapabilityDemand,
  refusal: GrantRefusal,
  clientName: string,
): string | undefined {
  if (refusal === 'granted' || refusal === 'ungated') return undefined;
  const noun = CAPABILITY_NOUNS[demand.capability];
  if (refusal === 'undetermined')
    return `this daemon cannot say what it is allowed to do with ${noun}, so it is doing nothing with it. Its grant document could not be read as a complete decision — run \`${clientName} daemon config\` on the host to see and repair it.`;
  if (refusal === 'not-granted')
    return demand.axis === 'use'
      ? `the operator of this machine has not granted the UI the use of ${noun}. Grant it on the host with \`${clientName} daemon config set ${demand.capability} --use\`.`
      : `the operator of this machine has not granted the UI permission to change the settings for ${noun}. Grant it on the host with \`${clientName} daemon config set ${demand.capability} --configure\`.`;
  if (refusal === 'rate-limited')
    return `too many wrong operator passwords have been tried, so this daemon is not checking any more of them for now. Wait for the lockout to pass, or clear it on the host with \`${clientName} daemon password set\`.`;
  // `locked` is the one refusal whose remedy is NOT a command for the person meeting it — they enter
  // the password they already have. But the person who does NOT have it was, until this sentence,
  // left at a dead end: the axis is granted, nothing is broken, and no instruction applied to them.
  // So it names both remedies and says which is whose, rather than assuming the reader is the
  // operator. Every branch of this function now ends somewhere a person can actually go.
  return `changing the settings for ${noun} needs this machine's operator password. Enter it to unlock, or — if you do not have it — somebody at the host can replace it with \`${clientName} daemon password set\`, or remove the requirement entirely with \`${clientName} daemon password clear\`.`;
}

/**
 * Applying an operator's patch to the recorded decision.
 *
 * TOTAL and non-destructive: an axis the patch does not name keeps its current value, so a stale tab
 * restating four answers it never looked at cannot revert a decision made in another one.
 */
export function applyGrantPatch(current: CapabilityGrants, patch: GrantsPatch): CapabilityGrants {
  const next: Record<DaemonCapability, CapabilityGrant> = { ...current };
  for (const capability of DAEMON_CAPABILITIES) {
    const change = patch[capability];
    if (change === undefined) continue;
    next[capability] = {
      use: change.use ?? current[capability].use,
      configure: change.configure ?? current[capability].configure,
    };
  }
  return next;
}

/** Which capabilities a patch would actually touch — the set whose `configure` axis it demands. */
export function patchedCapabilities(patch: GrantsPatch): readonly DaemonCapability[] {
  return DAEMON_CAPABILITIES.filter(capability => patch[capability] !== undefined);
}

/**
 * Which axes a change turns ON.
 *
 * THE ASYMMETRY IS THE POINT. Widening is the one change that hands a remote browser more than it
 * had, so it needs the operator password whenever one exists. Narrowing is what somebody does during
 * an incident, and a password prompt between a person and shutting a door is a liability — so
 * revoking is never harder than granting. A patch that only turns things off widens nothing and is
 * never gated.
 */
export function widenedBy(current: CapabilityGrants, next: CapabilityGrants): readonly string[] {
  const widened: string[] = [];
  for (const capability of DAEMON_CAPABILITIES) {
    if (!current[capability].use && next[capability].use) widened.push(`${capability}.use`);
    if (!current[capability].configure && next[capability].configure) widened.push(`${capability}.configure`);
  }
  return widened;
}

/** Every axis a change moves, in the order a report reads them, for the audit record. */
export function grantChanges(current: CapabilityGrants, next: CapabilityGrants): readonly string[] {
  const changes: string[] = [];
  for (const capability of DAEMON_CAPABILITIES) {
    for (const axis of ['use', 'configure'] as const) {
      const before = current[capability][axis];
      const after = next[capability][axis];
      if (before !== after) changes.push(`${capability}.${axis}=${after ? 'on' : 'off'}`);
    }
  }
  return changes;
}

/**
 * The wrong-password ledger.
 *
 * A LOCAL GATE THAT COUNTS IS WORTH LITTLE; ONE THAT DOES NOT IS WORTH NOTHING. Five tries is enough
 * for a person who mistypes and nowhere near enough for anything that guesses, and the lockout is
 * long enough that resuming after it is a decision rather than a retry loop.
 *
 * It is deliberately per-DAEMON rather than per-caller. A limiter keyed by device would hand an
 * attacker a fresh budget for every credential it holds, and one keyed by address would hand it one
 * for every proxy hop. The cost is that a wrong-typing operator can lock out a colleague's browser
 * for fifteen minutes — a real cost, taken knowingly, because the alternative bounds nothing.
 */
export interface UnlockAttemptState {
  readonly failures: number;
  /** Set while the daemon is refusing to check passwords. */
  readonly lockedUntilMs?: number;
}

export const INITIAL_UNLOCK_ATTEMPTS: UnlockAttemptState = { failures: 0 };

export function isUnlockLocked(state: UnlockAttemptState, nowMs: number): boolean {
  return state.lockedUntilMs !== undefined && nowMs < state.lockedUntilMs;
}

/**
 * A lapsed lockout resets the count rather than leaving the caller one try from another one.
 *
 * The alternative — keeping five failures forever — turns a fifteen-minute lockout into a permanent
 * one after a single further mistake, which denies the operator service rather than defending
 * against a guesser.
 */
export function unlockAttemptsRemaining(state: UnlockAttemptState, nowMs: number): number {
  if (isUnlockLocked(state, nowMs)) return 0;
  if (state.lockedUntilMs !== undefined) return GRANT_UNLOCK_MAX_ATTEMPTS;
  return Math.max(0, GRANT_UNLOCK_MAX_ATTEMPTS - state.failures);
}

export function recordUnlockFailure(state: UnlockAttemptState, nowMs: number): UnlockAttemptState {
  const carried = isUnlockLocked(state, nowMs) || state.lockedUntilMs === undefined ? state.failures : 0;
  const failures = carried + 1;
  if (failures < GRANT_UNLOCK_MAX_ATTEMPTS) return { failures };
  return { failures, lockedUntilMs: nowMs + GRANT_UNLOCK_LOCKOUT_SECONDS * 1_000 };
}

/** A correct password clears the ledger, lockout included: the holder has proved who they are. */
export function recordUnlockSuccess(): UnlockAttemptState {
  return INITIAL_UNLOCK_ATTEMPTS;
}

/** One demand named for a log line or a report row. */
export function describeDemand(capability: DaemonCapability, axis: CapabilityAxis): string {
  return `${capability}.${axis}`;
}
