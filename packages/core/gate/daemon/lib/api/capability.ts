import type { CapabilityDemand } from '@ferretry/kernel/contract';
import {
  CAPABILITY_NAMES,
  type CallerGovernance,
  type CapabilityGrants,
  type CapabilityPresentation,
  decideCapability,
  describeGrantRefusal,
  type GrantEvaluation,
  type GrantRefusal,
  type GuardDecision,
} from '../../../contract/index.ts';

// The rule itself is the contract's (`contract/capability-rule.ts`), so a plugin renders the same decision; re-exported here for Gate's own callers.
export { decideCapability, demandNeedsStepUp, type GrantEvaluation } from '../../../contract/index.ts';

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
      ...(presentation.connector === true ? { connector: true as const } : {}),
      ...(presentation.useAsksStepUp === undefined ? {} : { useAsksStepUp: presentation.useAsksStepUp }),
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
