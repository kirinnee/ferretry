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
 * on rather than a wall they start behind. Both axes are therefore enabled for all five
 * capabilities.
 *
 * THE SECURITY LAYER IS THE PASSWORD, NOT THE GRANT. A cautious operator sets an operator password;
 * every `configure` demand then needs an unlock, and the dangerous capabilities — `fleet`, which
 * materialises executables into accounts, and `warden`, which decides whether the daemon may spend
 * somebody's quota unattended — are gated behind it. An operator who wants no password is not
 * obstructed. The grant stays as the coarse switch for somebody who wants a capability gone
 * entirely.
 *
 * THE COST IS REAL AND IT IS NAMED. With these defaults and no password, anyone holding a pairing can
 * change this machine's fleet from off the host. Nobody is interrogated about it at setup — five
 * questions to use your own machine is exactly the friction this design removed — but the fact is
 * stated in one plain sentence wherever remote access is actually being arranged: see
 * `NO_PASSWORD_DISCLOSURE`.
 */
export const DEFAULT_CAPABILITY_GRANTS: CapabilityGrants = {
  fleet: { use: true, configure: true },
  terminal: { use: true, configure: true },
  browser: { use: true, configure: true },
  filesystem: { use: true, configure: true },
  warden: { use: true, configure: true },
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
  'no operator password is set, so any paired device can change this machine’s fleet and settings without one';

/**
 * Whether the operator's grants govern THIS caller.
 *
 * ONE INPUT, AND IT IS THE TRANSPORT'S. A loopback caller is already standing on the machine: they
 * can edit the configuration document, run the command line, or start anything they like. A
 * permission model that gated them would add friction and no safety, and it would make a document
 * that refuses everything a document nobody can edit back. So loopback is ungoverned, full stop, and
 * a fresh install needs no setup and no password to be useful.
 *
 * EVERY RESTRICTION IN THIS FILE EXISTS FOR THE CALLER WHO IS NOT ON THE HOST — a paired phone, a
 * browser across the network, a session carried over the rendezvous. That is where a boundary is
 * real, because possession of the machine is exactly what such a caller does not have.
 *
 * THE VALUE MUST BE CARRIER-DERIVED, and it is: the transport adapter sets `ApiRequest.loopback` from
 * the socket's actual remote address, and the relay tunnel — which terminates on this very host —
 * sets it to `false` unconditionally, whatever address the hop appears to carry. Deciding this from
 * a peer address, a `Host` header or a URL containing `127.0.0.1` would hand a remote phone the
 * machine, and that is the worst bug this design could produce. Nothing here re-derives it.
 */
export function isGovernedCaller(loopback: boolean): boolean {
  return !loopback;
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
  /** False for a loopback caller — somebody already standing on this host. See `isGovernedCaller`. */
  readonly governed: boolean;
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
  filesystem: 'session working trees',
  warden: 'fleet supervision',
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
  return `changing the settings for ${noun} needs the operator password on this machine. Unlock first, then try again.`;
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
