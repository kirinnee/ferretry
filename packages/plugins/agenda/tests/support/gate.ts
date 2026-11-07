import type { Admission, AdmissionDecision, ApiRequest, CallStanding, ScopedRoute } from '@ferretry/kernel/contract';
import { errorResponse } from '@ferretry/kernel/contract';
import type { TestCaller } from '@ferretry/kernel/testing';

/** The header a test names its caller in; the stand-in admission below reads it. */
const AS_HEADER = 'x-test-as';
export const as = (caller: TestCaller): { readonly headers: Readonly<Record<string, string>> } => ({
  headers: { [AS_HEADER]: JSON.stringify(caller) },
});

/**
 * An Admission that stamps the standing the way Gate does (`credential` and `actor`, today's `RouteContext` fields), so
 * a handler that reads WHO called is tested on the standing it will really get. Narrow and deny-by-default, like the
 * kernel's stand-in, but a ferret reaches an `operator` route (Gate lets a ferret's own token in) and the standing
 * carries a ferret's id and a device's principal. It proves no Gate guarantee.
 */
export function gateLikeAdmission(): Admission {
  const callerOf = (request: ApiRequest): TestCaller => {
    const raw = request.headers.get(AS_HEADER);
    return raw === undefined ? { kind: 'owner' } : (JSON.parse(raw) as TestCaller);
  };
  const refuse = (status: number, message: string, code: string): AdmissionDecision<never> => ({
    outcome: 'refused',
    response: errorResponse(status, message, code),
  });
  const decide = (request: ApiRequest, d: ScopedRoute): AdmissionDecision<CallStanding> => {
    const caller = callerOf(request);
    if (d.caller === 'person' && caller.kind === 'ferret')
      return refuse(403, 'Only the owner may do this.', 'owner_only');
    if (caller.kind === 'device' && d.capability !== undefined && caller.capabilities !== undefined) {
      const needed = `${d.capability.capability}.${d.capability.axis}`;
      if (!caller.capabilities.includes(needed))
        return refuse(403, `This device may not ${d.capability.axis} ${d.capability.capability}.`, 'capability_denied');
    }
    const standing =
      caller.kind === 'ferret'
        ? {
            actor: `ferret:${caller.id}`,
            credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: caller.id },
          }
        : caller.kind === 'device'
          ? {
              actor: `device:${caller.holder}`,
              credential: {
                kind: 'authenticated',
                tokenClass: 'device',
                principal: {
                  kind: 'device',
                  holder: caller.holder,
                  session: `session-${caller.holder}`,
                  leaseUntil: '2099-01-01T00:00:00.000Z',
                },
              },
            }
          : { actor: 'admin-cli', credential: { kind: 'authenticated', tokenClass: 'admin' } };
    return {
      outcome: 'admitted',
      standing: standing as unknown as CallStanding,
      actor: caller.kind === 'ferret' ? 'ferret' : 'owner-tools',
    };
  };
  return {
    admit: input => decide(input.request, input.descriptor),
    admitMember: () => refuse(403, 'Member routes are for members.', 'forbidden') as never,
    readmit: (request, descriptor) => decide(request, descriptor).outcome === 'admitted',
    inventory: (_request, entries) => entries,
  } as Admission;
}
