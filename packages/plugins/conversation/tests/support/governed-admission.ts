import {
  asksStepUpPerAction,
  type CapabilityGrants,
  coreCapabilityName,
  DEFAULT_GATE_CONFIG,
  type GateConfig,
  type GrantRefusal,
  GRANT_REFUSALS,
  STEP_UP_REQUIRED_CODE,
  STEP_UP_USE_CAPABILITIES,
} from '@ferretry/core-gate/contract';
import { deviceStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { Admission, AdmissionDecision, ApiRequest, CallStanding } from '@ferretry/kernel/contract';

/**
 * Gate's stand-in admission, given the one thing it lacks: the `governance` a `consultsGrants` route is handed.
 *
 * The stand-in already decides a demand the way Gate does (daemon-wide grants, then the device's own, then the
 * step-up rule). This asks it the SAME question for the demand the handler puts to `governance.decide`, by admitting a
 * copy of the route that declares that demand, so a decision is never skipped: the answer is the stand-in's refusal
 * or its admission. (The real `GateAdmission` is exercised against this route's declared descriptor in Gate's own
 * suite, `reference-menus.test.ts`: a test of another package cannot reach it.)
 */
export class GovernedAdmission implements Admission {
  readonly #stand: StandInAdmission;
  /** Each enrolled device's own grants. */
  readonly devices = new Map<string, CapabilityGrants>();
  /** The devices holding one unspent step-up; a spend (the handler's `spendStepUp`) takes it away, as Gate's ledger does. */
  readonly stepUps = new Set<string>();
  /** How many times a handler spent a step-up on this stand-in. */
  spent = 0;
  policy: GateConfig = DEFAULT_GATE_CONFIG;

  constructor() {
    this.#stand = new StandInAdmission(
      request => this.#standing(request),
      () => this.policy,
    );
  }

  enrol(device: string, grants: CapabilityGrants, options: { stepUp?: true } = {}): void {
    this.devices.set(device, grants);
    if (options.stepUp === true) this.stepUps.add(device);
  }

  #standing(request: ApiRequest): CallStanding | undefined {
    const principal = request.principal;
    if (principal?.kind === 'device') {
      const grants = this.devices.get(principal.holder);
      return deviceStanding(principal.holder, grants, this.stepUps.has(principal.holder));
    }
    if (request.arrival.kind === 'local') return ownerStanding();
    return undefined;
  }

  admit(input: Parameters<Admission['admit']>[0]): AdmissionDecision {
    const decided = this.#stand.admit(input);
    if (decided.outcome !== 'admitted' || input.descriptor.consultsGrants !== true) return decided;
    const presentation = decided.standing.presentation;
    const governed = presentation?.local !== true;
    const holder = input.request.principal?.kind === 'device' ? input.request.principal.holder : undefined;
    return {
      ...decided,
      standing: {
        ...decided.standing,
        spendStepUp: () => {
          this.spent += 1;
          if (holder !== undefined) this.stepUps.delete(holder);
        },
        governance: {
          governed,
          decide: demand => {
            const asked = this.#stand.admit({
              ...input,
              descriptor: { ...input.descriptor, capability: demand },
            });
            if (asked.outcome === 'admitted') {
              // An admitted demand that wanted a step-up was admitted ON the device's held one: say so, as Gate does.
              const name = coreCapabilityName(demand.capability);
              const wantsStepUp =
                demand.narrowing !== true &&
                governed &&
                asksStepUpPerAction(this.policy.security) &&
                (demand.axis === 'configure' || (name !== undefined && STEP_UP_USE_CAPABILITIES.includes(name)));
              return wantsStepUp
                ? { allowed: true, refusal: 'granted', steppedUp: true }
                : { allowed: true, refusal: 'granted' };
            }
            const code = (JSON.parse(String(asked.response.body)) as { code?: string }).code ?? '';
            if (code === STEP_UP_REQUIRED_CODE) return { allowed: false, refusal: 'step-up-required' };
            const refusal = GRANT_REFUSALS.find(name => code === `grant_${name.replaceAll('-', '_')}`);
            return { allowed: false, refusal: (refusal ?? 'undetermined') as GrantRefusal };
          },
        },
      },
    };
  }
  admitMember(): ReturnType<Admission['admitMember']> {
    return this.#stand.admitMember();
  }
  readmit(): boolean {
    return true;
  }
  inventory(_request: ApiRequest, entries: Parameters<Admission['inventory']>[1]) {
    return entries;
  }
}
