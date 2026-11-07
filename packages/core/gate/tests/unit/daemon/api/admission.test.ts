import { describe, expect, test } from 'bun:test';
import { type HolderId, type PolicyRef, type ScopedRoute } from '@ferretry/kernel/contract';
import { addDuration, minutes } from '@ferretry/std';
import {
  AUDIT_KINDS,
  cap,
  DEFAULT_GATE_CONFIG,
  DEFAULT_GATE_SECURITY,
  describeGrantRefusal,
  FULL_DEVICE_GRANTS,
  LIMITED_DEVICE_GRANTS,
  remedyRef,
  STEP_UP_ACTS,
} from '../../../../contract/index.ts';
import { holder } from '../../../../contract/testing/index.ts';
import { CLIENT_HEADER, SESSION_ID_HEADER } from '../../../../daemon/lib/api/admission.ts';
import {
  ADMIN,
  admit,
  carried,
  descriptor,
  FERRET,
  FERRET_TOKEN,
  fleetConfigure,
  fleetUse,
  later,
  local,
  request,
  terminalUse,
  WARDEN,
  world,
} from '../support.ts';

const allOff = Object.fromEntries(
  Object.keys(FULL_DEVICE_GRANTS).map(name => [name, { use: false, configure: false }]),
) as typeof FULL_DEVICE_GRANTS;
const narrowed = { ...DEFAULT_GATE_CONFIG, grants: allOff };
const perAct = { ...DEFAULT_GATE_CONFIG, security: { ...DEFAULT_GATE_SECURITY, stepUpOnActions: true } };
const person = (fields = {}) => descriptor({ caller: 'person', ...fields });

describe('who is governed', () => {
  test('G1 only the admin token at the machine is ungoverned; a device, a relayed admin token are governed', () => {
    const w = world({ policy: narrowed });
    w.enrol('phone');
    expect(admit(w, fleetUse, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('403 grant_not_granted');
    expect(admit(w, fleetUse, { bearer: ADMIN, arrival: carried() }).outcome).toBe('403 grant_not_granted');
  });

  test('G3 G138 the host command line is never narrowed by either document', () => {
    const w = world({ policy: narrowed });
    for (const route of [
      fleetUse,
      fleetConfigure,
      terminalUse,
      descriptor({ capability: cap('pairing', 'configure') }),
    ])
      expect(admit(w, route, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
  });

  test('G4 a browser on the host is a paired device and governed like every other device', () => {
    const w = world({ policy: narrowed });
    w.enrol('host-browser');
    // A browser always reaches the daemon over a sealed session (the `direct` carrier), never the local listener.
    expect(admit(w, fleetUse, { device: 'host-browser', arrival: carried('direct') }).outcome).toBe(
      '403 grant_not_granted',
    );
  });

  test('G6 G45 a fresh install with no gate.yaml grants both axes of everything, with no setup', () => {
    const w = world();
    w.enrol('phone');
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).toBe('admitted');
    expect(admit(w, terminalUse, { device: 'phone' }).outcome).toBe('admitted');
  });

  test('G9 governance and locality stay separate fields on the standing', () => {
    const w = world();
    w.enrol('phone');
    const { decision } = admit(w, fleetUse, { device: 'phone' });
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    expect(decision.standing.governance?.governed).toBe(true);
    expect(decision.standing.presentation?.local).toBe(false);
    const owner = admit(w, fleetUse, { bearer: ADMIN, arrival: local() }).decision;
    if (owner.outcome !== 'admitted') throw new Error('expected admitted');
    expect(owner.standing.governance?.governed).toBe(false);
    expect(owner.standing.presentation?.local).toBe(true);
  });
});

describe('ferrets and person routes', () => {
  test('G7 S35 a ferret token is refused on a person route with 403 owner_only, before the body is read', () => {
    const w = world();
    const { outcome, call } = admit(w, person(), { bearer: FERRET_TOKEN, arrival: local(true) });
    expect(outcome).toBe('403 owner_only');
    expect(call.bodyRead()).toBe(false);
  });

  test('G8 the admin token naming a ferret session is refused on a person route', () => {
    const w = world();
    expect(
      admit(w, person(), { bearer: ADMIN, arrival: local(), headers: { [SESSION_ID_HEADER]: 'F99' } }).outcome,
    ).toBe('403 owner_only');
  });

  test('G11 S30 a person route refuses the ferret token, the admin token naming a ferret and the warden', () => {
    const w = world();
    const route = person({ minimum: 'authenticated', ferretDoor: 'ask the owner with fy ask' });
    const ferret = admit(w, route, { bearer: FERRET_TOKEN, arrival: local(true) });
    expect(ferret.outcome).toBe('403 owner_only');
    expect(String(ferret.decision.outcome === 'refused' && ferret.decision.response.body)).toContain('fy ask');
    expect(admit(w, route, { bearer: ADMIN, headers: { [SESSION_ID_HEADER]: 'F1' } }).outcome).toBe('403 owner_only');
    expect(admit(w, route, { bearer: WARDEN, arrival: local() }).outcome).toBe('403 owner_only');
    expect(admit(w, route, { bearer: ADMIN, headers: { [CLIENT_HEADER]: 'cli' } }).outcome).toBe('admitted');
  });

  test('G10 a ferret token never meets the grants, and is looked up only on the privileged local listener', () => {
    const w = world({ policy: narrowed });
    expect(admit(w, terminalUse, { bearer: FERRET_TOKEN, arrival: local(true) }).outcome).toBe('admitted');
    expect(admit(w, terminalUse, { bearer: FERRET_TOKEN, arrival: local(false) }).outcome).toBe('401 unauthorized');
    expect(admit(w, terminalUse, { bearer: FERRET_TOKEN, arrival: carried() }).outcome).toBe('401 unauthorized');
  });

  test('G12 a caller:any route serves a ferret token as its own ferret, never as the owner', () => {
    const w = world();
    const { decision } = admit(w, fleetUse, { bearer: FERRET_TOKEN, arrival: local(true) });
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    expect(decision.actor).toBe('ferret');
    expect(decision.standing.actor).toBe(`ferret:${FERRET}`);
    expect(decision.standing.credential).toEqual({ kind: 'authenticated', tokenClass: 'ferret', ferret: FERRET });
  });

  test('S35 a ferret token naming another ferret in the header is 401 session_mismatch, and audited', () => {
    const w = world();
    const { outcome } = admit(w, fleetUse, {
      bearer: FERRET_TOKEN,
      arrival: local(true),
      headers: { [SESSION_ID_HEADER]: 'F99' },
    });
    expect(outcome).toBe('401 session_mismatch');
    expect(w.audits.map(a => a.event)).toEqual([AUDIT_KINDS['ferret.credential-refused']]);
    expect(w.audits[0]?.subject).toBe(FERRET);
  });

  test('G13 the caller rule only refuses: a person on a person route still meets every grant question', () => {
    const w = world({ policy: narrowed });
    w.enrol('phone');
    expect(admit(w, person({ capability: cap('fleet', 'use') }), { device: 'phone' }).outcome).toBe(
      '403 grant_not_granted',
    );
  });
});

describe('locality', () => {
  test('G17 a relayed call with every local-looking signal is still remote', () => {
    const w = world({ policy: narrowed });
    const { outcome, decision } = admit(w, fleetUse, {
      bearer: ADMIN,
      arrival: carried('relay'),
      clientAddress: '127.0.0.1',
      headers: { host: '127.0.0.1', 'x-forwarded-for': '127.0.0.1', origin: 'http://localhost' },
    });
    expect(outcome).toBe('403 grant_not_granted');
    expect(decision.outcome).toBe('refused');
  });

  test('G18 owner rules read arrival on the host: the admin token through the local listener, nothing else', () => {
    const w = world({ policy: narrowed });
    expect(admit(w, fleetUse, { bearer: ADMIN, arrival: local(false) }).outcome).toBe('admitted');
    expect(admit(w, fleetUse, { bearer: ADMIN, arrival: carried('tunnel') }).outcome).toBe('403 grant_not_granted');
  });

  test('G19 R262 the privileged-local proof admits only privilegedOnly routes and grants nothing', () => {
    const w = world();
    const open = descriptor({ minimum: 'none', privilegedOnly: true });
    const privileged = admit(w, open, { arrival: local(true) }).decision;
    expect(privileged.outcome).toBe('admitted');
    if (privileged.outcome === 'admitted') expect(privileged.standing).toEqual({});
    expect(admit(w, open, { arrival: local(false) }).outcome).toBe('403 forbidden');
    expect(admit(w, open, { arrival: carried() }).outcome).toBe('403 forbidden');
  });

  test('G26 a privilegedOnly route refuses every relayed, tunnelled or WebRTC caller before its handler', () => {
    const w = world();
    w.enrol('phone');
    const openUrl = descriptor({ method: 'POST', path: '/v1/system/open-url', privilegedOnly: true });
    for (const carrier of ['relay', 'tunnel', 'webrtc', 'direct']) {
      expect(admit(w, openUrl, { bearer: ADMIN, arrival: carried(carrier) }).outcome).toBe('403 forbidden');
      expect(admit(w, openUrl, { device: 'phone', arrival: carried(carrier) }).outcome).toBe('403 forbidden');
    }
    expect(admit(w, openUrl, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
  });
});

describe('the unlock and the step-up', () => {
  test('G74 R253 a locked device gets 401 unlock_required on everything but the routes it needs to get in', () => {
    const w = world();
    w.enrol('phone', FULL_DEVICE_GRANTS, false);
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('401 unlock_required');
    expect(admit(w, descriptor({ unlockExempt: true }), { device: 'phone' }).outcome).toBe('admitted');
  });

  test('G75 G77 validity is the provider’s unlockedUntil judged at the call: a lapsed unlock asks again', () => {
    const w = world();
    w.enrol('phone');
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('admitted');
    w.now = later(w.now, 61 * 60_000);
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('401 unlock_required');
  });

  test('G47 G79 the unlock stands in for the step-up, unless the owner asked for one per act', () => {
    const w = world();
    w.enrol('phone');
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).toBe('admitted');
    expect(admit(w, terminalUse, { device: 'phone' }).outcome).toBe('admitted');
    w.policy = perAct;
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('admitted');
    w.policy = { ...DEFAULT_GATE_CONFIG, security: { ...DEFAULT_GATE_SECURITY, unlockOnOpen: false } };
    expect(admit(w, terminalUse, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
  });

  test('G78 G100 a step-up is a memory fact about one device and app session; no device holds none', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const subject = { deviceId: 'phone', appSession: 's-phone' };
    w.stepUps.grant(subject);
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).toBe('admitted');
    const admin = admit(w, fleetConfigure, { bearer: ADMIN, arrival: carried() }).decision;
    expect(admin.outcome).toBe('refused');
    const owner = admit(w, fleetUse, { bearer: ADMIN, arrival: local() }).decision;
    if (owner.outcome === 'admitted') expect(owner.standing.presentation?.stepUp).toBe(false);
  });

  test('G97 a window of 0 admits exactly one act per step-up; the unlock is never spent', () => {
    const w = world({ policy: { ...perAct, security: { ...perAct.security, stepUpWindowMinutes: 0 } } });
    w.enrol('phone');
    w.stepUps.grant({ deviceId: 'phone', appSession: 's-phone' });
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).toBe('admitted');
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
    w.policy = DEFAULT_GATE_CONFIG;
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).toBe('admitted');
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).toBe('admitted');
  });

  test('G101 the step-up refusal is grant_step_up_required and names the demand', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const { decision } = admit(w, fleetConfigure, { device: 'phone' });
    if (decision.outcome !== 'refused') throw new Error('expected refused');
    expect(JSON.parse(String(decision.response.body))).toMatchObject({
      code: 'grant_step_up_required',
      demand: { capability: 'fleet', axis: 'configure' },
    });
  });

  test('G103 G157 a remote warden is governed, can never step up, and is refused off-host unless honoured', () => {
    const w = world();
    const wardenFleet = descriptor({ minimum: 'authenticated', capability: cap('fleet', 'use') });
    expect(admit(w, wardenFleet, { bearer: WARDEN, arrival: carried() }).outcome).toBe('401 unauthorized');
    w.policy = { ...DEFAULT_GATE_CONFIG, warden: { remote: true } };
    expect(admit(w, wardenFleet, { bearer: WARDEN, arrival: carried() }).outcome).toBe('admitted');
    expect(
      admit(w, descriptor({ minimum: 'authenticated', capability: cap('warden', 'configure') }), {
        bearer: WARDEN,
        arrival: carried(),
      }).outcome,
    ).toBe('403 grant_step_up_required');
  });

  test('G127 a narrowing route asks its grant and the unlock, never a per-act passkey', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const revoke = descriptor({ capability: cap('pairing', 'use', { narrowing: true }) });
    expect(admit(w, revoke, { device: 'phone' }).outcome).toBe('admitted');
    w.enrol('locked', FULL_DEVICE_GRANTS, false);
    expect(admit(w, revoke, { device: 'locked' }).outcome).toBe('401 unlock_required');
    // A governed caller with no device (the admin token off the host) is refused as it was when it had to step up.
    expect(admit(w, revoke, { bearer: ADMIN, arrival: carried() }).outcome).toBe('403 grant_step_up_required');
  });

  test('G82 a fresh proof is claimed once, for its own act', () => {
    const w = world();
    w.enrol('phone');
    const subject = { deviceId: 'phone', appSession: 's-phone' };
    w.stepUps.grant(subject, true, STEP_UP_ACTS.addDevice);
    const { decision } = admit(w, fleetUse, { device: 'phone' });
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    const claim = decision.standing.claimFreshStepUp;
    expect(claim?.(STEP_UP_ACTS.widenDevice)).toBe(false);
    expect(claim?.(STEP_UP_ACTS.addDevice)).toBe(true);
    expect(claim?.(STEP_UP_ACTS.addDevice)).toBe(false);
  });

  test('G81 an unlock is never a fresh proof for any act (no proof can be recorded until Access can hand one over)', () => {
    const w = world();
    w.enrol('phone');
    const { decision } = admit(w, fleetUse, { device: 'phone' });
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    for (const act of [STEP_UP_ACTS.addDevice, STEP_UP_ACTS.widenDevice, STEP_UP_ACTS.catalogInstall])
      expect(decision.standing.claimFreshStepUp?.(act)).toBe(false);
  });

  test('G83 G84 every-caller acts take only a proof bound to their subject; the admin token has none', () => {
    const w = world();
    w.enrol('phone');
    const subject = { deviceId: 'phone', appSession: 's-phone' };
    const stage = 'st_0123456789abcdef01234567' as const;
    w.stepUps.grantBound(subject, STEP_UP_ACTS.addTwoFactorKey, stage);
    const { decision } = admit(w, fleetUse, { device: 'phone' });
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    expect(decision.standing.claimFreshStepUp?.(STEP_UP_ACTS.addTwoFactorKey, 'st_ffffffffffffffffffffffff')).toBe(
      false,
    );
    expect(decision.standing.claimFreshStepUp?.(STEP_UP_ACTS.addTwoFactorKey, stage)).toBe(true);
    const owner = admit(w, fleetUse, { bearer: ADMIN, arrival: local() }).decision;
    if (owner.outcome !== 'admitted') throw new Error('expected admitted');
    expect(owner.standing.claimFreshStepUp?.(STEP_UP_ACTS.addTwoFactorKey, stage)).toBe(false);
  });

  test('G85 a stored proof is claimed only through claimStoredProof, for the challenge it answered', () => {
    const w = world();
    w.enrol('phone');
    const subject = { deviceId: 'phone', appSession: 's-phone' };
    const stage = 'srs_0123456789abcdef01234567' as const;
    const challenge = new Uint8Array([9, 9, 9]);
    const evidence = {
      holder: holder('phone'),
      credentialId: 'c',
      clientDataJSON: 'd',
      authenticatorData: 'a',
      signature: 's',
    };
    w.stepUps.grantBound(subject, STEP_UP_ACTS.approveSignInRule, stage, { evidence, challenge });
    const { decision } = admit(w, fleetUse, { device: 'phone' });
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    expect(decision.standing.claimStoredProof?.(STEP_UP_ACTS.approveSignInRule, stage, new Uint8Array([1]))).toBe(
      undefined,
    );
    expect(decision.standing.claimStoredProof?.(STEP_UP_ACTS.approveSignInRule, stage, challenge)).toEqual(evidence);
    expect(decision.standing.claimStoredProof?.(STEP_UP_ACTS.approveSignInRule, stage, challenge)).toBe(undefined);
  });
});

describe('the grant layer', () => {
  test('G132 the grant layer runs after authentication, the minimum and privilegedOnly', () => {
    const w = world({ policy: narrowed });
    expect(admit(w, fleetUse, { arrival: carried() }).outcome).toBe('401 unauthorized');
    expect(
      admit(w, descriptor({ minimum: 'admin-token', capability: cap('fleet', 'use') }), { bearer: WARDEN }).outcome,
    ).toBe('403 forbidden');
  });

  test('G133 G136 the effective grant is the daemon-wide grant AND the device grant', () => {
    const w = world();
    w.enrol('limited', LIMITED_DEVICE_GRANTS);
    expect(admit(w, fleetUse, { device: 'limited' }).outcome).toBe('admitted');
    expect(admit(w, terminalUse, { device: 'limited' }).outcome).toBe('403 grant_device_not_granted');
  });

  test('G139 a refusal names which half refused, the daemon-wide half first', () => {
    const w = world({ policy: narrowed });
    w.enrol('limited', LIMITED_DEVICE_GRANTS);
    expect(admit(w, terminalUse, { device: 'limited' }).outcome).toBe('403 grant_not_granted');
  });

  test('G140 a proved device whose record is gone is undetermined, never served unnarrowed', () => {
    const w = world();
    expect(admit(w, fleetUse, { device: 'ghost' }).outcome).toBe('403 grant_undetermined');
    expect(admit(w, descriptor(), { device: 'ghost' }).outcome).toBe('403 grant_undetermined');
  });

  test('P112 R240 a device revoked while a call is in flight is refused at admission', () => {
    const w = world();
    w.enrol('phone');
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('admitted');
    w.devices.revoke(holder('phone'));
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('401 unauthorized');
  });

  test('R605 with no provider bound, a device call is refused like a stranger', () => {
    const w = world();
    w.enrol('phone');
    w.devicesOff = true;
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('401 unauthorized');
  });

  for (const off of [true, 'throwing'] as const)
    test(`G74 G100 with the step-up provider ${off === true ? 'missing (Access off)' : 'throwing'}, every device must unlock and nobody holds a step-up`, () => {
      const w = world();
      w.enrol('phone');
      w.stepUps.grant({ deviceId: 'phone', appSession: 's-phone' });
      expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('admitted');
      w.stepUpsOff = off;
      // The unlock is the witness's to vouch for: with none, the device is asked to unlock again.
      expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('401 unlock_required');
      const exempt = descriptor({ unlockExempt: true });
      const decision = admit(w, exempt, { device: 'phone' }).decision;
      if (decision.outcome !== 'admitted') throw new Error('an unlock-exempt route still serves the device');
      expect(decision.standing.presentation?.stepUp).toBe(false);
      expect(decision.standing.presentation?.freshStepUp).toBe(false);
      expect(decision.standing.claimFreshStepUp?.()).toBe(false);
      // The owner at the machine needs no step-up, so is served whatever Access is doing.
      expect(admit(w, fleetConfigure, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
    });

  test('G74 the witness and the device’s own unlock must agree: either one saying locked asks for the unlock', () => {
    const w = world();
    w.enrol('phone', FULL_DEVICE_GRANTS, false);
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('401 unlock_required');
  });

  test('G154 an undetermined gate.yaml refuses every governed capability; the owner is still served', () => {
    const w = world({ policy: undefined });
    w.enrol('phone');
    w.enrol('locked', FULL_DEVICE_GRANTS, false);
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('403 grant_undetermined');
    // The unlock is asked the stricter way while the settings cannot be read.
    expect(admit(w, fleetUse, { device: 'locked' }).outcome).toBe('401 unlock_required');
    expect(admit(w, fleetUse, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
  });

  test('G156 G55 every grant refusal names a command that fixes it', () => {
    for (const refusal of ['undetermined', 'not-granted', 'device-not-granted'] as const)
      expect(describeGrantRefusal(cap('terminal', 'use') as never, refusal, 'fy')).toMatch(/`fy |gate\.yaml/u);
  });

  test('P20 the operator minimum is met by any credential but a warden’s, a paired device included', () => {
    const w = world({ policy: { ...DEFAULT_GATE_CONFIG, warden: { remote: true } } });
    w.enrol('phone');
    const operator = descriptor({ minimum: 'operator' });
    expect(admit(w, operator, { device: 'phone' }).outcome).toBe('admitted');
    expect(admit(w, operator, { bearer: ADMIN }).outcome).toBe('admitted');
    expect(admit(w, operator, { bearer: WARDEN }).outcome).toBe('403 forbidden');
  });
});

describe('warden remedies', () => {
  test('G21 a remedy route refuses a warden while no remedy authorizer is wired (fail closed)', () => {
    const w = world();
    const leave = descriptor({
      minimum: 'authenticated',
      method: 'POST',
      path: '/v1/warden/leave',
      wardenRemedy: remedyRef('leave'),
    });
    expect(
      admit(w, leave, { bearer: WARDEN, arrival: local(), headers: { 'x-fy-warden-capability': 'cap-1' } }).outcome,
    ).toBe('403 warden_remedy_unwired');
    expect(admit(w, leave, { bearer: WARDEN, arrival: local() }).outcome).toBe('403 warden_capability_required');
    // The header never promotes a non-warden into the remedy question.
    expect(
      admit(w, leave, { bearer: ADMIN, arrival: local(), headers: { 'x-fy-warden-capability': 'cap-1' } }).outcome,
    ).toBe('admitted');
  });
});

describe('members', () => {
  test('R617 a member is admitted only to its table, unlocked when asked, and only to catalogs it was given', () => {
    const w = world();
    w.members.enrol(holder('m1'), FULL_DEVICE_GRANTS, addDuration(w.now, minutes(5)));
    const call = request({ member: 'm1' });
    expect(admit(w, fleetUse, { member: 'm1' }).outcome).toBe('403 forbidden');
    const member = w.gate.admitMember({
      table: 'member',
      descriptor: {
        method: 'GET',
        path: '/v1/shared/x',
        member: 'unlocked',
        noStore: true,
        audit: { skip: 't' },
        guard: { none: 't' },
      },
      request: call,
      params: new Map(),
    });
    expect(member.outcome).toBe('admitted');
    const gone = w.gate.admitMember({
      table: 'member',
      descriptor: {
        method: 'GET',
        path: '/v1/shared/x',
        member: 'key',
        noStore: true,
        audit: { skip: 't' },
        guard: { none: 't' },
      },
      request: request({ member: 'nobody' }),
      params: new Map(),
    });
    expect(gone.outcome === 'refused' && gone.response.status).toBe(401);
  });
});

describe('audit after the handler', () => {
  test('G150 a descriptor-declared record names the act, the actor from the credential and the outcome', () => {
    const w = world();
    w.enrol('phone');
    const route = descriptor({
      method: 'DELETE',
      path: '/v1/pair/devices/:deviceId',
      audit: { record: AUDIT_KINDS['device.revoked'] as PolicyRef<'audit'> },
    });
    const { decision, call } = admit(w, route, { device: 'phone' });
    if (decision.outcome !== 'admitted') throw new Error('expected admitted');
    const told = (on: ScopedRoute, status = 200) =>
      w.gate.recorded({
        table: 'route',
        descriptor: on,
        request: call,
        params: new Map([['deviceId', 'other']]),
        standing: decision.standing,
        actor: decision.actor,
        status,
        response: { status, headers: new Map(), body: '{}' },
      });
    told(route);
    told(descriptor());
    // Today's rule for this route: the device id is the subject, the status is in the detail.
    expect(w.recorded).toEqual([
      {
        event: AUDIT_KINDS['device.revoked'],
        actor: { kind: 'device', deviceId: 'phone' as HolderId },
        subject: 'other',
        outcome: 'succeeded',
        detail: { status: 200 },
      },
    ]);
  });
});
