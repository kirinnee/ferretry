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
 * on rather than a wall they start behind. Both axes are therefore enabled for all eight capabilities,
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
  secrets: { use: true, configure: true },
  sharing: { use: true, configure: true },
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
 * Every `configure`, and the `use` of the capabilities whose ordinary use already reaches past the
 * daemon — except a {@link CapabilityDemand.narrowing} route's, which only takes away and asks the grant alone: `terminal` is arbitrary code on the host, `browser` drives a browser the operator is signed
 * into, `pairing` hands out credentials for the machine, and `sharing` publishes its material to people
 * who are not its devices. Every other `use` — watching
 * sessions, reading the fleet, the filesystem view, the warden — is ordinary operation and needs
 * nothing beyond the grant.
 */
export function demandNeedsStepUp(demand: CapabilityDemand): boolean {
  if (demand.narrowing === true) return false;
  if (demand.axis === 'configure') return true;
  return STEP_UP_USE_CAPABILITIES.has(demand.capability);
}

/**
 * `secrets.use` is here because it RUNS A COMMAND — the value goes into a child's environment — so it is
 * code execution on the host exactly as a terminal is (`docs/design/zero-trust.md` B1).
 *
 * `sharing.use` is here because it makes this machine VOUCH for something: an export is signed with the
 * daemon identity and handed to people outside it (`docs/grants.md`, capability eight).
 */
const STEP_UP_USE_CAPABILITIES: ReadonlySet<DaemonCapability> = new Set([
  'terminal',
  'browser',
  'pairing',
  'secrets',
  'sharing',
]);

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
  /**
   * What the caller's OWN paired device has been granted, for a governed device caller.
   *
   * `undefined` for a caller that is not a paired device (a remote warden) — no device narrowing then
   * applies, because there is no device record to narrow by — and for an ungoverned caller, which nothing
   * narrows. `null` is a device the session proved but whose record is gone: it is refused, never treated
   * as unnarrowed.
   */
  readonly device?: CapabilityGrants | null;
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
  // effective = daemonWide ∧ device. The machine-wide answer is asked first so its remedy, a host
  // change for everyone, is named before the per-device one.
  if (evaluation.device === null) return { allowed: false, refusal: 'undetermined' };
  if (evaluation.device !== undefined) {
    const own = evaluation.device[demand.capability];
    if (!own.use || (demand.axis === 'configure' && !own.configure))
      return { allowed: false, refusal: 'device-not-granted' };
  }
  // A narrowing skips the per-act step-up, never the proven device it stood for (secrev-1329b L3): a governed caller
  // with no device (the admin token off loopback, a remote warden) is refused as it was when it had to step up.
  if (
    demand.narrowing === true &&
    evaluation.device === undefined &&
    demandNeedsStepUp({ capability: demand.capability, axis: demand.axis })
  )
    return { allowed: false, refusal: 'step-up-required' };
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
  secrets: 'the secret store',
  sharing: 'catalog sharing',
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
  if (refusal === 'device-not-granted')
    return `this device has not been given ${demand.axis === 'use' ? 'the use of' : 'permission to change the settings for'} ${noun}. Grant it at the machine with \`${clientName} device grant <device> ${demand.capability} --${demand.axis}\`, or from a device that holds it and may manage devices.`;
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
 * THE ASYMMETRY IS THE POINT.  * Widening is the one change that hands a remote browser more than it
 * had, so a governed caller may make it only for what it holds itself, with a live step-up and a passkey proved for
 * it. A pure narrowing only takes away, so it needs neither (docs/grants.md § Narrowing never asks again).
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

/** Everything one device-grant change is judged by. None of it comes from the request body. */
export interface DeviceGrantJudgement {
  /** The device's grants now, and what the patch would make them. */
  readonly current: CapabilityGrants;
  readonly next: CapabilityGrants;
  /** Whether the caller arrived on the host — ungoverned, so every widen is its to make. */
  readonly hostLocal: boolean;
  /** Whether the caller's device holds a live passkey step-up. */
  readonly stepUp: boolean;
  /** Whether it proved a passkey for THIS act — what a widen needs, never merely the unlock. */
  readonly freshStepUp: boolean;
  /**
   * What the CALLER may do itself, effective (daemon-wide ∧ its own device), or `undefined` for a
   * governed caller that is not a paired device and therefore holds nothing it could pass on.
   */
  readonly holder: CapabilityGrants | undefined;
}

/** Why a device-grant change was refused, in a vocabulary the service turns into a status. */
export type DeviceGrantVerdict =
  | { readonly kind: 'allowed' }
  /** A change that is not a pure narrowing, from a governed caller with no live step-up. */
  | { readonly kind: 'step-up-required' }
  /** A legal widen, without a passkey proved for it alone. */
  | { readonly kind: 'widen-step-up-required' }
  | { readonly kind: 'forbidden'; readonly widened: readonly string[] };

/**
 * Which axes a caller may turn ON for another device (`docs/design/zero-trust.md` B5).
 *
 * At the machine, every axis. Remotely, an axis the caller itself holds effectively — and only when it
 * also holds `pairing.configure`, the permission to manage devices. NO DEVICE CAN GRANT WHAT IT DOES NOT
 * HOLD, so nothing escalates: the most a device can give another is a copy of what it already has.
 * `configure` needs the matching `use` too, because a device must never hold `configure` without `use`.
 */
export function widenableBy(hostLocal: boolean, holder: CapabilityGrants | undefined): CapabilityGrants {
  const managesDevices = holder?.pairing.use === true && holder.pairing.configure;
  const answer: Record<DaemonCapability, CapabilityGrant> = { ...ALL_OFF_GRANTS };
  for (const capability of DAEMON_CAPABILITIES) {
    if (hostLocal) answer[capability] = { use: true, configure: true };
    else if (managesDevices && holder !== undefined)
      answer[capability] = {
        use: holder[capability].use,
        configure: holder[capability].use && holder[capability].configure,
      };
  }
  return answer;
}

const ALL_OFF_GRANTS: CapabilityGrants = Object.fromEntries(
  DAEMON_CAPABILITIES.map(capability => [capability, { use: false, configure: false }]),
) as CapabilityGrants;

/**
 * The one decision about a change to ONE device's grants, field by field, refused WHOLE.
 *
 * - A caller on the host may make any change: it already has the machine (B4).
 * - A governed PURE narrowing — on any device, its own included — needs nothing beyond the grant and the unlock: no
 *   per-act step-up, whatever "ask again for each act" says. Revoking is never harder than granting. Anything that is
 *   not a pure narrowing needs the live step-up, as every change did before.
 * - A governed widen is allowed only for axes {@link widenableBy} lists. One illegal widen refuses the
 *   whole patch, so a mixed patch never half-applies.
 * - A legal governed widen needs a passkey proved FOR IT (owner decision 2026-10-14): an unlock, or a
 *   step-up merely inside its window, is not enough to give another device more access.
 *
 * The forbidden verdict is checked before the step-up one: a widen no step-up could buy must not ask
 * for a passkey first and then refuse anyway.
 */
export function judgeDeviceGrantChange(judgement: DeviceGrantJudgement): DeviceGrantVerdict {
  if (judgement.hostLocal) return { kind: 'allowed' };
  const allowed = widenableBy(false, judgement.holder);
  const illegal = widenedBy(judgement.current, judgement.next).filter(axis => {
    const [capability, which] = axis.split('.') as [DaemonCapability, CapabilityAxis];
    return !allowed[capability][which];
  });
  if (illegal.length > 0) return { kind: 'forbidden', widened: illegal };
  if (widenedBy(judgement.current, judgement.next).length === 0) return { kind: 'allowed' };
  if (!judgement.stepUp) return { kind: 'step-up-required' };
  if (!judgement.freshStepUp) return { kind: 'widen-step-up-required' };
  return { kind: 'allowed' };
}

/**
 * A device patch applied, with `configure ⇒ use` kept true of the RESULT.
 *
 * Turning `configure` on turns `use` on with it, and turning `use` off turns `configure` off with it, so
 * a device can never hold the incoherent "may reconfigure what it may not use". The coupled axis is
 * judged like any other: a `configure` widen that drags `use` on must be allowed for `use` too.
 */
export function applyDeviceGrantPatch(current: CapabilityGrants, patch: GrantsPatch): CapabilityGrants {
  const next: Record<DaemonCapability, CapabilityGrant> = { ...applyGrantPatch(current, patch) };
  for (const capability of DAEMON_CAPABILITIES) {
    const change = patch[capability];
    if (change === undefined) continue;
    // A patch naming `use: false` and `configure: true` together narrows: the safer reading wins.
    if (change.use === false) next[capability] = { use: false, configure: false };
    else if (change.configure === true) next[capability] = { use: true, configure: true };
  }
  return next;
}

/** `left ∧ right`, axis by axis — the effective grant of a device under the daemon-wide document. */
export function intersectGrants(left: CapabilityGrants, right: CapabilityGrants): CapabilityGrants {
  return Object.fromEntries(
    DAEMON_CAPABILITIES.map(capability => [
      capability,
      {
        use: left[capability].use && right[capability].use,
        configure: left[capability].configure && right[capability].configure,
      },
    ]),
  ) as CapabilityGrants;
}
