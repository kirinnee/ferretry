import type { CapabilityDemand } from '@ferretry/kernel/contract';
import {
  type CapabilityGrants,
  type CapabilityName,
  coreCapabilityName,
  type GrantRefusal,
  STEP_UP_USE_CAPABILITIES,
} from './policy.ts';

/**
 * THE ONE GRANT RULE (today's `decideCapability`): the single place authority is removed for a governed caller. It lives
 * in the contract so Gate's admission and every plugin that renders a grants decision (Access's push routes) ask the SAME
 * function and no plugin carries a copy that could drift from it.
 */

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
  /** See `CapabilityPresentation.useAsksStepUp`; absent asks. */
  readonly useAsksStepUp?: boolean;
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
  // THE OWNER'S TWO SWITCHES ARE THE ONLY SOURCE OF A PROMPT FOR A PLAIN USE: with the per-act confirmation off, a use
  // (a read included) asks nothing, whether or not the machine also unlocks on opening. A configure still asks.
  if (
    (demand.axis === 'use' || demand.promptsAsUse === true) &&
    evaluation.useAsksStepUp === false &&
    evaluation.device !== undefined
  )
    return { allowed: true, refusal: 'granted' };
  if (!evaluation.stepUp) return { allowed: false, refusal: 'step-up-required' };
  return { allowed: true, refusal: 'granted', steppedUp: true };
}
