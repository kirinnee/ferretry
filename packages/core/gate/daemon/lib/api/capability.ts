import type { CapabilityDemand } from '@ferretry/kernel/contract';
import {
  CAPABILITY_NAMES,
  type CallerGovernance,
  type CapabilityGrants,
  type CapabilityName,
  type CapabilityPresentation,
  coreCapabilityName,
  describeGrantRefusal,
  type GrantRefusal,
  STEP_UP_USE_CAPABILITIES,
} from '../../../contract/index.ts';

/**
 * THE SECOND AUTHORIZATION QUESTION, asked after the first one has already been answered (today's
 * `api/capability.ts` and the decision half of `grants/policy.ts`, copied).
 *
 * A route's credential minimum and privileged-arrival declaration answer who may reach it at all. This answers what
 * the OPERATOR decides for their machine: of the things that credential could do, which have I agreed a caller who is
 * NOT standing on this host may do? A grant is consulted only once both route checks have passed, and it can only
 * ever remove what the scope already allowed.
 *
 * "LOCAL" IS HOW THE CALL ARRIVED, NEVER WHAT IT CLAIMS. The relay terminates ON this host, so a check that read a
 * peer address, a `Host` header or a URL would see local for a phone on the other side of the world. The presentation
 * carries `arrivedOnHost`'s proof, decided from the kernel's own listener. Nothing in this file re-derives it, and no
 * header can move it.
 */

/** Whether the operator's grants govern THIS caller: every caller but the owner at the machine (today's rule). */
export function isGovernedCaller(arrival: { readonly local: boolean }): boolean {
  return !arrival.local;
}

/**
 * The demands that need a passkey step-up from a governed caller even when the axis is granted: every `configure`,
 * and the `use` of terminal, browser, pairing, secrets and sharing — except a narrowing route's (today's
 * `demandNeedsStepUp`).
 */
export function demandNeedsStepUp(demand: CapabilityDemand): boolean {
  if (demand.narrowing === true) return false;
  if (demand.axis === 'configure') return true;
  const name = coreCapabilityName(demand.capability);
  // A capability Gate does not know is asked the stricter way.
  return name === undefined || STEP_UP_USE_CAPABILITIES.includes(name);
}

/** Everything the per-call decision reads, gathered so none of it comes from a global (today's `GrantEvaluation`). */
export interface GrantEvaluation {
  /** The daemon-wide half (`gate.yaml`), or `undefined` when it cannot be read as a decision: undetermined. */
  readonly grants: CapabilityGrants | undefined;
  readonly governed: boolean;
  /** Whether the call ARRIVED on this host. Today it is exactly `!governed`; kept apart so widening reads its fact. */
  readonly hostLocal: boolean;
  readonly stepUp: boolean;
  /** The proved device's own half; `undefined` for a caller that is not a device; `null` for one whose record is gone. */
  readonly device?: CapabilityGrants | null;
}

/**
 * The contract's `GrantDecision`, said as the two shapes it comes in: an allowance is always `granted`, and a refusal never
 * is, so a refusal always has words to say ({@link describeGrantRefusal}) and no caller has to handle one without.
 */
export type GuardDecision =
  | { readonly allowed: true; readonly refusal: 'granted'; readonly steppedUp?: true }
  | { readonly allowed: false; readonly refusal: Exclude<GrantRefusal, 'granted'> };

/**
 * The one decision, and the only place authority is ever removed (today's `decideCapability`, verbatim in order).
 *
 * IT NEVER GRANTS. Every branch either keeps the answer the route's scope check already produced or removes it.
 * `configure` IMPLIES `use`.
 */
export function decideCapability(demand: CapabilityDemand, evaluation: GrantEvaluation): GuardDecision {
  if (!evaluation.governed) return { allowed: true, refusal: 'granted' };
  const grants = evaluation.grants;
  // A daemon that cannot say what it is enforcing enforces nothing. Permissive defaults settle SILENCE, never damage.
  if (grants === undefined) return { allowed: false, refusal: 'undetermined' };
  const name: CapabilityName | undefined = coreCapabilityName(demand.capability);
  if (name === undefined) return { allowed: false, refusal: 'undetermined' };
  const grant = grants[name];
  if (!grant.use) return { allowed: false, refusal: 'not-granted' };
  if (demand.axis === 'configure' && !grant.configure) return { allowed: false, refusal: 'not-granted' };
  // effective = daemonWide ∧ device. The machine-wide answer is asked first so its remedy is named first.
  if (evaluation.device === null) return { allowed: false, refusal: 'undetermined' };
  if (evaluation.device !== undefined) {
    const own = evaluation.device[name];
    if (!own.use || (demand.axis === 'configure' && !own.configure))
      return { allowed: false, refusal: 'device-not-granted' };
  }
  // A narrowing skips the per-act step-up, never the proven device it stood for: a governed caller with no device (the
  // admin token off the host, a remote warden) is refused as it was when it had to step up.
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

/** The grant layer as the boundary sees it (today's `CapabilityGuard`). Synchronous, deliberately. */
export interface CapabilityGuard {
  decide(demand: CapabilityDemand, presentation: CapabilityPresentation): GuardDecision;
  governance(presentation: CapabilityPresentation): CallerGovernance;
  explain(demand: CapabilityDemand, refusal: Exclude<GrantRefusal, 'granted'>): string;
}

/**
 * The guard over `gate.yaml`'s daemon-wide half and the device half on the presentation (today's grants service
 * `guard`). `daemonWide` answers `undefined` while the document is undetermined, which refuses every governed caller.
 */
export function grantGuard(daemonWide: () => CapabilityGrants | undefined, clientName: string): CapabilityGuard {
  const evaluate = (presentation: CapabilityPresentation): GrantEvaluation => {
    const governed = isGovernedCaller(presentation);
    return {
      grants: daemonWide(),
      governed,
      hostLocal: !governed,
      stepUp: presentation.stepUp,
      ...(governed && presentation.deviceGrants !== undefined ? { device: presentation.deviceGrants } : {}),
    };
  };
  return {
    decide: (demand, presentation) => decideCapability(demand, evaluate(presentation)),
    governance: presentation => {
      const evaluation = evaluate(presentation);
      return { governed: evaluation.governed, decide: demand => decideCapability(demand, evaluation) };
    },
    explain: (demand, refusal) => describeGrantRefusal(demand, refusal, clientName),
  };
}

/** `left ∧ right`, axis by axis — the effective grant of a device under the daemon-wide document (G133). */
export function intersectGrants(left: CapabilityGrants, right: CapabilityGrants): CapabilityGrants {
  return Object.fromEntries(
    CAPABILITY_NAMES.map(name => [
      name,
      { use: left[name].use && right[name].use, configure: left[name].configure && right[name].configure },
    ]),
  ) as CapabilityGrants;
}
