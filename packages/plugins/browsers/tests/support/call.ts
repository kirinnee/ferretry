import type { AuthenticatedCredential, CallerGovernance, CapabilityPresentation } from '@ferretry/core-gate/contract';
import type { CallContext } from '@ferretry/kernel/contract';
import type { FerretId } from '@ferretry/kernel/contract';

/** Who a handler test is: the owner at the machine, a paired device, or a ferret's own token. */
export type CallerKind = 'host' | 'device' | 'agent';

const CREDENTIAL: Record<CallerKind, AuthenticatedCredential> = {
  host: { kind: 'authenticated', tokenClass: 'admin' },
  device: { kind: 'authenticated', tokenClass: 'device', principal: { kind: 'device', holder: 'd1' } as never },
  agent: { kind: 'authenticated', tokenClass: 'ferret', ferret: 's1' as FerretId },
};
const ACTOR: Record<CallerKind, string> = { host: 'admin-cli', device: 'device:d1', agent: 'ferret:s1' };

/**
 * One passkey proof as Access holds it: fresh until a claim takes it, and the claim is atomic (of two claims exactly
 * one is answered `true`). Share one across several `callOf` calls to stand for requests admitted on the SAME proof.
 */
export interface OneProof {
  fresh: boolean;
  /** How many claims took the proof (never more than one per proof). */
  claimed: number;
}

export const oneProof = (fresh = true): OneProof => ({ fresh, claimed: 0 });

/**
 * A handler's `CallContext` as Gate stamps it (today's `RouteContext` the route tests built): the request, the raw
 * params, and the standing. `spent` counts the fresh proofs the handler took. `presentation.freshStepUp` is the
 * admission SNAPSHOT (`fresh`, or the shared `proof` as it stood when the call was built), so two calls built before
 * either runs both say fresh, as two requests racing on one proof would.
 */
export function callOf(options: {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly kind?: CallerKind;
  readonly fresh?: boolean;
  /** The proof this call's claim takes; defaults to a private one that is fresh when `fresh` is. */
  readonly proof?: OneProof;
  readonly params?: Readonly<Record<string, string>>;
}): { readonly call: CallContext; readonly spent: () => number } {
  const kind = options.kind ?? 'host';
  const proof = options.proof ?? oneProof(options.fresh === true);
  const snapshot = proof.fresh;
  const text = options.body === undefined ? '' : JSON.stringify(options.body);
  const governance: CallerGovernance = {
    governed: kind === 'device',
    decide: () => ({ allowed: true, refusal: 'granted' }) as never,
  };
  const presentation: CapabilityPresentation = {
    local: kind !== 'device',
    adminToken: kind === 'host',
    actor: ACTOR[kind],
    stepUp: snapshot,
    freshStepUp: snapshot,
  };
  const call = {
    request: {
      method: options.method,
      path: options.path,
      query: new URLSearchParams() as never,
      headers: new Map([['content-type', 'application/json']]) as never,
      arrival: (kind === 'device'
        ? { kind: 'carried', carrier: 'relay' }
        : { kind: 'local', privileged: false }) as never,
      text: async () => text,
    },
    params: options.params ?? {},
    actor: ACTOR[kind],
    credential: CREDENTIAL[kind],
    governance,
    presentation,
    claimFreshStepUp: () => {
      if (!proof.fresh) return false;
      proof.fresh = false;
      proof.claimed += 1;
      return true;
    },
  } as unknown as CallContext;
  return { call, spent: () => proof.claimed };
}
