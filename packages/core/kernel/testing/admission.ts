import type { Instant } from '@ferretry/std';
import type { Actor } from '../contract/act.ts';
import type { Admission, AdmissionDecision, AdmissionInput } from '../contract/bound.ts';
import type { ApiRequest } from '../contract/http.ts';
import { errorResponse } from '../contract/http.ts';
import type { CarrierKey, HolderId, SessionId } from '../contract/ids.ts';
import type { CallStanding, MemberStanding, ScopedRoute } from '../contract/route.ts';
import type { Arrival, LocalArrival } from '../contract/session.ts';

/** Who a test request comes from. The test host turns it into an arrival, a principal and headers. */
export type TestCaller =
  | { readonly kind: 'owner' }
  | { readonly kind: 'ferret'; readonly id: string }
  | { readonly kind: 'device'; readonly holder: string; readonly capabilities?: readonly string[] }
  | { readonly kind: 'member'; readonly holder: string }
  | { readonly kind: 'warden'; readonly remedies?: readonly string[] }
  | { readonly kind: 'anonymous' };

export const owner = (): TestCaller => ({ kind: 'owner' });
export const ferret = (id: string): TestCaller => ({ kind: 'ferret', id });
export const device = (holder: string, capabilities?: readonly string[]): TestCaller =>
  capabilities === undefined ? { kind: 'device', holder } : { kind: 'device', holder, capabilities };
export const member = (holder: string): TestCaller => ({ kind: 'member', holder });
export const warden = (remedies?: readonly string[]): TestCaller =>
  remedies === undefined ? { kind: 'warden' } : { kind: 'warden', remedies };
export const anonymous = (): TestCaller => ({ kind: 'anonymous' });

/** Only the test host (in the kernel package) makes a local arrival, as only the kernel's listener does in a daemon. */
export function testArrival(caller: TestCaller): Arrival {
  if (caller.kind === 'owner' || caller.kind === 'ferret')
    return { kind: 'local', privileged: caller.kind === 'ferret' } as LocalArrival;
  return { kind: 'carried', carrier: 'relay' as CarrierKey };
}

export function testPrincipal(caller: TestCaller, leaseUntil: Instant): ApiRequest['principal'] {
  if (caller.kind !== 'device' && caller.kind !== 'member') return undefined;
  return {
    kind: caller.kind,
    holder: caller.holder as HolderId,
    session: `session-${caller.holder}` as SessionId,
    leaseUntil,
  };
}

/** The stand-in's standing: who called. Gate's real standing replaces it when the real Gate is passed. */
export interface StandInStanding {
  readonly caller: TestCaller;
}

/**
 * The Admission stand-in (§7.8: "the real Gate when available, else a stand-in behind the Admission port"). It is a
 * narrow, deny-by-default reading of today's descriptor questions, enough to test a plugin's own behaviour: it is
 * NOT Gate and proves no Gate guarantee. `minimum: 'none'` admits anyone; otherwise an anonymous caller is `401`;
 * `caller: 'person'` refuses a ferret (`403 owner_only`); `admin-token` is the owner only; `operator` refuses
 * ferrets and wardens; a warden needs the route's `wardenRemedy` in its remedies; `privilegedOnly` needs a privileged
 * local arrival; a device needs the route's capability in its list when it was given one.
 */
export function standInAdmission(callerOf: (request: ApiRequest) => TestCaller): Admission {
  const refuse = (status: number, message: string, code: string): AdmissionDecision<never> => ({
    outcome: 'refused',
    response: errorResponse(status, message, code),
  });
  const decide = (request: ApiRequest, d: ScopedRoute): AdmissionDecision<CallStanding> => {
    const caller = callerOf(request);
    const actor: Actor = caller.kind === 'warden' ? 'warden' : caller.kind === 'ferret' ? 'ferret' : 'owner-tools';
    const admitted = { outcome: 'admitted', standing: { caller } as CallStanding, actor } as const;
    if (caller.kind === 'warden') {
      if (d.wardenRemedy === undefined || !(caller.remedies ?? []).includes(d.wardenRemedy))
        return refuse(403, 'A warden may not act here.', 'forbidden');
      return admitted;
    }
    if (d.minimum === 'none') return admitted;
    if (caller.kind === 'anonymous' || caller.kind === 'member') return refuse(401, 'Sign in first.', 'unauthorized');
    if (d.caller === 'person' && caller.kind === 'ferret')
      return refuse(
        403,
        `Only the owner may do this.${d.ferretDoor === undefined ? '' : ` ${d.ferretDoor}`}`,
        'owner_only',
      );
    if (d.minimum === 'admin-token' && caller.kind !== 'owner')
      return refuse(403, 'Only the owner at the machine may do this.', 'forbidden');
    if (d.minimum === 'operator' && caller.kind === 'ferret')
      return refuse(403, 'Only the operator may do this.', 'forbidden');
    if (
      d.privilegedOnly === true &&
      !(request.arrival.kind === 'local' && request.arrival.privileged) &&
      caller.kind !== 'owner'
    )
      return refuse(403, 'This is only served on the privileged local listener.', 'forbidden');
    if (caller.kind === 'device' && d.capability !== undefined && caller.capabilities !== undefined) {
      const needed = `${d.capability.capability}.${d.capability.axis}`;
      if (!caller.capabilities.includes(needed) && !caller.capabilities.includes(d.capability.capability))
        return refuse(403, `This device may not ${d.capability.axis} ${d.capability.capability}.`, 'capability_denied');
    }
    return admitted;
  };
  return {
    admit: (input: AdmissionInput & { readonly table: 'route' | 'socket' | 'tool' }) =>
      decide(input.request, input.descriptor),
    admitMember: (input: AdmissionInput & { readonly table: 'member' }) => {
      const caller = callerOf(input.request);
      if (caller.kind !== 'member')
        return refuse(403, 'Member routes are for members.', 'forbidden') as AdmissionDecision<MemberStanding>;
      return { outcome: 'admitted', standing: { caller } as unknown as MemberStanding, actor: 'owner-tools' as const };
    },
    readmit: (request, descriptor) => decide(request, descriptor).outcome === 'admitted',
    // The stand-in shows every package; Gate's real projection (§9.6) is Gate's to test.
    inventory: (_request, entries) => entries,
  };
}
