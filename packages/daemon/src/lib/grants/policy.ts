import {
  type CapabilityAxis,
  type CapabilityGrant,
  type CapabilityGrants,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
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
 * THE PRIMARY SECURITY LAYER IS LOCALITY. A remote caller can never turn a capability ON — not with a
 * step-up, not ever. Widening is a local act, so the dangerous half of this model is structurally
 * unavailable to a stolen phone and the worst it can do is narrow the machine's own permissions.
 * Starting open therefore costs far less than it would if a remote caller could grant itself things.
 *
 * THE PASSKEY STEP-UP IS THE SECOND LAYER, over every remote `configure` and the remote `use` of
 * `terminal`, `browser` and `pairing` (see {@link demandNeedsStepUp}). It needs no setup beyond pairing:
 * the device's passkey is the one the person already holds.
 *
 * WHAT THIS DOES NOT REDUCE, and the honest thing to say about these defaults: locality bounds what a
 * remote caller may GRANT, and the step-up bounds which device-and-session may act, but neither says
 * what an already-granted capability may DO once confirmed. `terminal.use` is arbitrary code on the
 * host. A paired device is trusted with that by default, so pairing — not this layer — is where that
 * decision is actually made.
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
 * Everything the governance question reads about ONE caller. None of it is self-reported.
 *
 * `loopback` is the dispatcher's `arrivedOnHost` answer: the transport's own account of where the
 * request came from, and for a browser the host proof. It is never a peer address, a `Host` header or
 * a URL — the relay terminates on this very host, and its tunnel sets `loopback: false`
 * unconditionally whatever address the hop appears to carry.
 */
export interface CallerArrival {
  /** Whether the request PROVED it arrived on this host. Carrier-derived; a relayed hop never does. */
  readonly loopback: boolean;
}

/**
 * Whether the operator's grants govern THIS caller.
 *
 * EVERY CALLER BUT THE OWNER AT THE MACHINE. The owner — the command line holding the admin token, over loopback — already has the
 * machine, so a grant or a step-up asked of it would be friction with no safety. Every other caller is
 * governed: a paired phone, a browser across the network, a session carried over the rendezvous, and a
 * browser on the host itself, which a tunnel to 127.0.0.1 is indistinguishable from (B4). That
 * is where a boundary is real, because possession of the machine is exactly what such a caller lacks.
 *
 * Deciding this from a peer address, a `Host` header or a URL containing `127.0.0.1` would hand a
 * remote phone the machine, and that is the worst bug this design could produce. Nothing here
 * re-derives it.
 */
export function isGovernedCaller(arrival: CallerArrival): boolean {
  return !arrival.loopback;
}

/**
 * The demands that need a passkey step-up from a governed caller even when the axis is granted.
 *
 * Every `configure`, and the `use` of the three capabilities whose ordinary use already reaches past
 * the daemon: `terminal` is arbitrary code on the host, `browser` drives a browser the operator is
 * signed into, and `pairing` hands out credentials for the machine. Every other `use` — watching
 * sessions, reading the fleet, the filesystem view, the warden — is ordinary operation and needs
 * nothing beyond the grant.
 */
export function demandNeedsStepUp(demand: CapabilityDemand): boolean {
  if (demand.axis === 'configure') return true;
  return STEP_UP_USE_CAPABILITIES.has(demand.capability);
}

const STEP_UP_USE_CAPABILITIES: ReadonlySet<DaemonCapability> = new Set(['terminal', 'browser', 'pairing']);

/** Everything the per-request decision reads, gathered so none of it comes from a global. */
export interface GrantEvaluation {
  readonly grants: EnforcedGrants;
  /** Whether the operator's grants apply to this caller at all. See {@link isGovernedCaller}. */
  readonly governed: boolean;
  /**
   * Whether the request ARRIVED on this host — the locality fact that decides whether a capability can
   * ever be turned back ON. Today it is exactly `!governed`; it is kept as its own field so widening
   * reads the fact it means rather than a rule it would have to restate.
   */
  readonly hostLocal: boolean;
  /** Whether this caller's proven device holds a live passkey step-up for this app session. */
  readonly stepUp: boolean;
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
  if (demand.axis === 'configure' && !grant.configure) return { allowed: false, refusal: 'not-granted' };
  if (!demandNeedsStepUp(demand)) return { allowed: true, refusal: 'granted' };
  if (!evaluation.stepUp) return { allowed: false, refusal: 'step-up-required' };
  return { allowed: true, refusal: 'granted', steppedUp: true };
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
 * to confirm, or are looking at a decision somebody made on purpose. `clientName` is threaded in so
 * the message names the command a human actually runs rather than one this file invents.
 *
 * `granted` returns nothing: a caller that was served needs no explanation.
 */
export function describeGrantRefusal(
  demand: CapabilityDemand,
  refusal: GrantRefusal,
  clientName: string,
): string | undefined {
  if (refusal === 'granted') return undefined;
  const noun = CAPABILITY_NOUNS[demand.capability];
  if (refusal === 'undetermined')
    return `this daemon cannot say what it is allowed to do with ${noun}, so it is doing nothing with it. Its grant document could not be read as a complete decision — run \`${clientName} daemon config\` on the host to see and repair it.`;
  if (refusal === 'not-granted')
    return demand.axis === 'use'
      ? `the operator of this machine has not granted the UI the use of ${noun}. Grant it on the host with \`${clientName} daemon config set ${demand.capability} --use\`.`
      : `the operator of this machine has not granted the UI permission to change the settings for ${noun}. Grant it on the host with \`${clientName} daemon config set ${demand.capability} --configure\`.`;
  return demand.axis === 'use'
    ? `using ${noun} needs a passkey confirmation from this device.`
    : `changing the settings for ${noun} needs a passkey confirmation from this device.`;
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
 * had, so only a caller on the host may make it — no step-up buys it. A governed caller may only
 * narrow, and since narrowing is a `configure` act it needs the same step-up as any other.
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

/** One demand named for a log line or a report row. */
export function describeDemand(capability: DaemonCapability, axis: CapabilityAxis): string {
  return `${capability}.${axis}`;
}
