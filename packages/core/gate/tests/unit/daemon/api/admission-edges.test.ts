import { describe, expect, test } from 'bun:test';
import type { HolderId, MemberRouteDescriptor, PolicyRef, RouteParameters } from '@ferretry/kernel/contract';
import { addDuration, minutes } from '@ferretry/std';
import {
  AUDIT_KINDS,
  type CredentialProvider,
  type MemberHolderStanding,
  type remedyRef,
} from '../../../../contract/index.ts';
import { GateAdmission, SESSION_ID_HEADER } from '../../../../daemon/lib/api/admission.ts';
import { FailClosedStepUps } from '../../../../daemon/lib/step-up/witness.ts';
import { ADMIN, admit, descriptor, FERRET_TOKEN, fleetUse, local, request, WARDEN, world } from '../support.ts';

describe('what a descriptor can declare that the shipped routes do not', () => {
  test('a route that asks no credential but is not for every caller still serves the owner, and no one else off the host', () => {
    const w = world();
    const owner = descriptor({ minimum: 'none', caller: 'person' });
    expect(admit(w, owner, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
    expect(admit(w, owner).outcome).toBe('401 unauthorized');
  });

  test('a warden presenting a capability for a remedy the route names blank is refused as invalid, not guessed at', () => {
    const w = world();
    w.remedies = { decide: () => ({ allowed: false, refusal: 'never asked' }) };
    const blank = descriptor({
      minimum: 'authenticated',
      method: 'POST',
      path: '/v1/warden/blank',
      wardenRemedy: '   ' as ReturnType<typeof remedyRef>,
    });
    expect(
      admit(w, blank, { bearer: WARDEN, arrival: local(), headers: { 'x-fy-warden-capability': 'cap-1' } }).outcome,
    ).toBe('403 warden_remedy_invalid');
  });
});

describe('the watchers of a policy change', () => {
  test('G149 a watcher that throws does not hide the change from the next, and a cancelled one is told nothing', () => {
    const w = world();
    const told: string[] = [];
    w.gate.watch(() => {
      throw new Error('this watcher is broken');
    });
    const cancel = w.gate.watch(() => told.push('first'));
    w.gate.watch(() => told.push('second'));
    w.gate.policyChanged();
    cancel();
    w.gate.policyChanged();
    expect(told).toEqual(['first', 'second', 'second']);
  });
});

describe('an audit log that fails is never the call’s failure', () => {
  test('a descriptor-declared record the log refuses to take is attempted once and does not throw', () => {
    const w = world();
    const route = descriptor({
      method: 'DELETE',
      path: '/v1/pair/devices/:deviceId',
      audit: { record: AUDIT_KINDS['device.revoked'] as PolicyRef<'audit'> },
    });
    const { decision, call } = admit(w, route, { bearer: ADMIN, arrival: local() });
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    let attempts = 0;
    w.recorded.push = () => {
      attempts += 1;
      throw new Error('the audit log is full');
    };
    expect(() =>
      w.gate.recorded({
        table: 'route',
        descriptor: route,
        request: call,
        params: new Map([['deviceId', 'other']]),
        standing: decision.standing,
        actor: decision.actor,
        status: 200,
        response: { status: 200, headers: new Map(), body: '{}' },
      }),
    ).not.toThrow();
    expect(attempts).toBe(1);
  });

  test('a ferret token refused for naming another ferret is still answered 401 when the audit log will not take the refusal', () => {
    const w = world();
    w.audits.push = () => {
      throw new Error('the audit log is full');
    };
    const { outcome } = admit(w, fleetUse, {
      bearer: FERRET_TOKEN,
      arrival: local(true),
      headers: { [SESSION_ID_HEADER]: 'F99' },
    });
    expect(outcome).toBe('401 session_mismatch');
  });
});

describe('a device whose provider fails', () => {
  test('R605 a provider that throws when asked is refused like a stranger, never served', () => {
    const w = world();
    w.enrol('phone');
    Object.assign(w.devices, {
      standing: () => {
        throw new Error('the device store is unreadable');
      },
    });
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('401 unauthorized');
  });
});

/** A member provider with the standing each test hands it: Catalogs' `credentials:member`, in memory. */
function memberProvider(standing: (holder: HolderId) => MemberHolderStanding | 'unknown' | 'revoked') {
  const provider: CredentialProvider<MemberHolderStanding> = {
    standing: id => standing(id),
    generation: () => 0,
  };
  return provider;
}

describe('R617 a member is admitted by what its provider says now', () => {
  const route = (fields: Partial<MemberRouteDescriptor> = {}): MemberRouteDescriptor => ({
    method: 'GET',
    path: '/v1/shared/:catalogId/x',
    member: 'key',
    noStore: true,
    audit: { skip: 't' },
    guard: { none: 't' },
    ...fields,
  });
  const ask = (
    standing: (id: HolderId) => MemberHolderStanding | 'unknown' | 'revoked',
    descriptor: MemberRouteDescriptor,
    params: RouteParameters = new Map(),
  ) => {
    const w = world();
    const withMembers = new GateAdmission({
      tokens: () => ({ admin: ADMIN, warden: WARDEN }),
      ferrets: () => undefined,
      devices: () => undefined,
      members: () => memberProvider(standing),
      policy: () => w.policy,
      stepUps: new FailClosedStepUps(() => undefined),
      now: () => w.now,
      refused: () => {},
      clientName: 'fy',
    });
    return withMembers.admitMember({
      table: 'member',
      descriptor,
      request: request({ member: 'm1' }),
      params,
    });
  };
  const given =
    (catalogs: readonly string[], unlockedUntil?: ReturnType<typeof world>['now']) =>
    (id: HolderId): MemberHolderStanding => ({
      kind: 'member',
      holder: id,
      catalogs,
      ...(unlockedUntil === undefined ? {} : { unlockedUntil }),
    });
  const status = (decision: ReturnType<typeof ask>) => (decision.outcome === 'refused' ? decision.response.status : 0);
  const code = (decision: ReturnType<typeof ask>) =>
    decision.outcome === 'refused' ? (JSON.parse(String(decision.response.body)) as { code: string }).code : '';

  test('a provider that throws is a revoked member: 401', () => {
    const decision = ask(() => {
      throw new Error('the member store is unreadable');
    }, route());
    expect(status(decision)).toBe(401);
  });

  test('an unlocked-only route asks a member with no unlock, or a lapsed one, to unlock with its passkey: 403 member_locked', () => {
    const w = world();
    const lapsed = addDuration(w.now, minutes(-5));
    for (const unlockedUntil of [undefined, lapsed]) {
      const decision = ask(given([], unlockedUntil), route({ member: 'unlocked' }));
      expect(status(decision)).toBe(403);
      expect(code(decision)).toBe('member_locked');
    }
  });

  test('a catalog named in the path that the member was not given reads as absent: 404 not_found', () => {
    const missing = ask(given(['other']), route({ catalog: 'path' }), new Map([['catalogId', 'mine']]));
    expect(status(missing)).toBe(404);
    expect(code(missing)).toBe('not_found');
    const unnamed = ask(given(['mine']), route({ catalog: 'path' }));
    expect(status(unnamed)).toBe(404);
  });

  test('a catalog the member was given is admitted, whether the path names it catalogId or catalog', () => {
    for (const key of ['catalogId', 'catalog']) {
      const decision = ask(given(['mine']), route({ catalog: 'path' }), new Map([[key, 'mine']]));
      expect(decision.outcome).toBe('admitted');
    }
  });

  test('a member holder the provider has never heard of is refused 401', () => {
    expect(status(ask(() => 'unknown', route()))).toBe(401);
  });
});
