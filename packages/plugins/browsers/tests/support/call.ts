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
 * A handler's `CallContext` as Gate stamps it (today's `RouteContext` the route tests built): the request, the raw
 * params, and the standing. `spent` counts fresh step-ups the handler spent.
 */
export function callOf(options: {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly kind?: CallerKind;
  readonly fresh?: boolean;
  readonly params?: Readonly<Record<string, string>>;
}): { readonly call: CallContext; readonly spent: () => number } {
  const kind = options.kind ?? 'host';
  let spent = 0;
  const text = options.body === undefined ? '' : JSON.stringify(options.body);
  const governance: CallerGovernance = {
    governed: kind === 'device',
    decide: () => ({ allowed: true, refusal: 'granted' }) as never,
  };
  const presentation: CapabilityPresentation = {
    local: kind !== 'device',
    adminToken: kind === 'host',
    actor: ACTOR[kind],
    stepUp: options.fresh === true,
    freshStepUp: options.fresh === true,
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
    spendFreshStepUp: () => {
      spent += 1;
    },
  } as unknown as CallContext;
  return { call, spent: () => spent };
}
