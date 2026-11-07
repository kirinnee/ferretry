import {
  type CapabilityGrants,
  DEFAULT_GATE_CONFIG,
  type GateConfig,
  type GrantRefusal,
  GRANT_REFUSALS,
  STEP_UP_REQUIRED_CODE,
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
  policy: GateConfig = DEFAULT_GATE_CONFIG;

  constructor() {
    this.#stand = new StandInAdmission(
      request => this.#standing(request),
      () => this.policy,
    );
  }

  enrol(device: string, grants: CapabilityGrants): void {
    this.devices.set(device, grants);
  }

  #standing(request: ApiRequest): CallStanding | undefined {
    const principal = request.principal;
    if (principal?.kind === 'device') {
      const grants = this.devices.get(principal.holder);
      return deviceStanding(principal.holder, grants);
    }
    if (request.arrival.kind === 'local') return ownerStanding();
    return undefined;
  }

  admit(input: Parameters<Admission['admit']>[0]): AdmissionDecision {
    const decided = this.#stand.admit(input);
    if (decided.outcome !== 'admitted' || input.descriptor.consultsGrants !== true) return decided;
    const presentation = decided.standing.presentation;
    const governed = presentation?.local !== true;
    return {
      ...decided,
      standing: {
        ...decided.standing,
        governance: {
          governed,
          decide: demand => {
            const asked = this.#stand.admit({
              ...input,
              descriptor: { ...input.descriptor, capability: demand },
            });
            if (asked.outcome === 'admitted') return { allowed: true, refusal: 'granted' };
            const code = (JSON.parse(String(asked.response.body)) as { code?: string }).code ?? '';
            if (code === STEP_UP_REQUIRED_CODE) return { allowed: false, refusal: 'step-up-required' };
            const refusal = GRANT_REFUSALS.find(name => code === `grant_${name.replaceAll('-', '_')}`);
            return { allowed: false, refusal: (refusal ?? 'undetermined') as GrantRefusal };
          },
        },
      },
    };
  }

  admitMember(input: Parameters<Admission['admitMember']>[0]) {
    return this.#stand.admitMember(input);
  }
  readmit(request: ApiRequest, descriptor: Parameters<Admission['readmit']>[1]): boolean {
    return this.#stand.readmit(request, descriptor);
  }
  inventory(...args: Parameters<Admission['inventory']>) {
    return this.#stand.inventory(...args);
  }
}
