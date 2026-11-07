import { describe, expect, test } from 'bun:test';
import type { SessionId } from '@ferretry/kernel/contract';
import {
  type CapabilityPresentation,
  cap,
  DEFAULT_CAPABILITY_GRANTS,
  DEFAULT_GATE_CONFIG,
  DEFAULT_SECURITY_SETTINGS,
  FULL_DEVICE_GRANTS,
  GateConfigSchema,
  LIMITED_DEVICE_GRANTS,
  ReadCapabilityGrantsSchema,
  STEP_UP_ACTS,
} from '../../../../contract/index.ts';
import { holder } from '../../../../contract/testing/index.ts';
import { CLIENT_HEADER, SESSION_ID_HEADER } from '../../../../daemon/lib/api/admission.ts';
import { decideCapability, intersectGrants } from '../../../../daemon/lib/api/capability.ts';
import { GrantError, GrantService } from '../../../../daemon/lib/grants/service.ts';
import manifest from '../../../../manifest.ts';
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
  terminalUse,
  WARDEN,
  type World,
  world,
} from '../support.ts';

/**
 * Appendix D rows Gate owns, each pinned through Gate's own decision: admission on a descriptor shaped as today's
 * route declares it, the step-up registry, and the grant surface. What the route's own handler or another plugin
 * decides (a body schema, a 404, a stored file) is that plugin's test, not this one.
 */

const allOff = Object.fromEntries(
  Object.keys(FULL_DEVICE_GRANTS).map(name => [name, { use: false, configure: false }]),
) as typeof FULL_DEVICE_GRANTS;
const narrowed = { ...DEFAULT_GATE_CONFIG, grants: allOff };
const perAct = { ...DEFAULT_GATE_CONFIG, security: { ...DEFAULT_SECURITY_SETTINGS, stepUpOnActions: true } };
const honoured = { ...DEFAULT_GATE_CONFIG, warden: { remote: true } };
const offFor = (name: keyof typeof FULL_DEVICE_GRANTS) => ({
  ...DEFAULT_GATE_CONFIG,
  grants: { ...DEFAULT_CAPABILITY_GRANTS, [name]: { use: false, configure: false } },
});
const person = (fields = {}) => descriptor({ caller: 'person', ...fields });
const subjectOf = (id: string) => ({ holder: holder(id), session: `s-${id}` as SessionId });
const ferretCall = { bearer: FERRET_TOKEN, arrival: local(true) };
const adminNamingFerret = { bearer: ADMIN, arrival: local(), headers: { [SESSION_ID_HEADER]: FERRET } };

/** An admitted call's standing, or a thrown refusal. */
function standing(w: World, route: Parameters<typeof admit>[1], options: Parameters<typeof admit>[2] = {}) {
  const { decision } = admit(w, route, options);
  if (decision.outcome !== 'admitted') throw new Error(`expected admitted, got ${admit(w, route, options).outcome}`);
  return decision.standing;
}

function grants(start = DEFAULT_CAPABILITY_GRANTS) {
  let current = start;
  return new GrantService({
    document: {
      read: () => current,
      written: () => [],
      write: async next => {
        current = next;
      },
    },
    history: { record: async () => undefined, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
    clock: { now: () => '2026-11-07T12:00:00.000Z' },
    clientName: 'fy',
  });
}

const failure = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'applied';
  } catch (error) {
    return error instanceof GrantError ? `${error.failure}: ${error.message}` : String(error);
  }
};

describe('who is governed, and the unlock', () => {
  test('G2 a governed device does nothing until it unlocks; then what is granted, with no prompt unless asked per act', () => {
    const w = world();
    w.enrol('locked', FULL_DEVICE_GRANTS, false);
    for (const route of [fleetUse, fleetConfigure, terminalUse, descriptor()])
      expect(admit(w, route, { device: 'locked' }).outcome).toBe('401 unlock_required');
    w.enrol('phone');
    for (const route of [fleetUse, fleetConfigure, terminalUse])
      expect(admit(w, route, { device: 'phone' }).outcome).toBe('admitted');
    w.policy = perAct;
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
  });

  test('G5 a browser on the host is a device: it confirms dangerous acts and can never widen a grant', async () => {
    const w = world({ policy: perAct });
    w.enrol('host-browser');
    const onHost = { device: 'host-browser', arrival: local() };
    expect(admit(w, terminalUse, onHost).outcome).toBe('403 grant_step_up_required');
    const presentation = standing(w, fleetUse, onHost).presentation as CapabilityPresentation;
    expect(presentation.local).toBe(false);
    const svc = grants({ ...DEFAULT_CAPABILITY_GRANTS, fleet: { use: false, configure: true } });
    expect(svc.view(presentation).capabilities.every(c => !c.mayGrant)).toBe(true);
    expect(await failure(svc.patch({ fleet: { use: true } }, { ...presentation, stepUp: true }))).toContain(
      'forbidden',
    );
  });

  test('G50 the unlock needs no setup beyond pairing: no gate.yaml, a paired device, and the settings read before it', () => {
    const w = world({ policy: GateConfigSchema.parse({}) });
    expect(w.policy?.security.unlockOnOpen).toBe(true);
    w.enrol('phone', FULL_DEVICE_GRANTS, false);
    const security = manifest.actions.routes.find(route => route.key === 'GET /v1/security');
    expect(security?.unlockExempt).toBe(true);
    expect(admit(w, descriptor({ unlockExempt: true }), { device: 'phone' }).outcome).toBe('admitted');
    w.enrol('phone');
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('admitted');
  });

  test('G77 validity is judged at the call against what the provider says now: a lapsed unlock asks again at once', () => {
    const w = world();
    w.enrol('phone');
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('admitted');
    w.now = later(w.now, 60 * 60_000);
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('401 unlock_required');
    w.enrol('phone');
    w.devices.revoke(holder('phone'));
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('401 unauthorized');
  });

  test('G79 while unlocked the step-up is held for every act unless stepUpOnActions; with the unlock off, every act asks', () => {
    const w = world();
    w.enrol('phone');
    for (const name of ['fleet', 'terminal', 'browser', 'pairing', 'secrets', 'sharing'] as const)
      expect(admit(w, descriptor({ capability: cap(name, 'configure') }), { device: 'phone' }).outcome).toBe(
        'admitted',
      );
    w.policy = perAct;
    expect(admit(w, descriptor({ capability: cap('browser', 'use') }), { device: 'phone' }).outcome).toBe(
      '403 grant_step_up_required',
    );
    w.policy = { ...DEFAULT_GATE_CONFIG, security: { ...DEFAULT_SECURITY_SETTINGS, unlockOnOpen: false } };
    expect(admit(w, descriptor({ capability: cap('secrets', 'use') }), { device: 'phone' }).outcome).toBe(
      '403 grant_step_up_required',
    );
  });

  test('G100 a step-up is a memory fact of one device and app session; with no proven device steppedUp is false', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'));
    expect(standing(w, fleetUse, { device: 'phone' }).presentation?.stepUp).toBe(true);
    // Another app session of the same device holds nothing.
    w.stepUps.grant({ holder: holder('phone'), session: 'another' as SessionId });
    expect(admit(w, fleetUse, { bearer: ADMIN, arrival: carried() }).outcome).toBe('admitted');
    expect(standing(w, fleetUse, { bearer: ADMIN, arrival: carried() }).presentation?.stepUp).toBe(false);
    expect(standing(w, fleetUse, { bearer: ADMIN, arrival: local() }).presentation?.stepUp).toBe(false);
  });

  test('G135 a newly paired device holds every capability, behind the unlock', () => {
    expect(intersectGrants(DEFAULT_CAPABILITY_GRANTS, FULL_DEVICE_GRANTS)).toEqual(DEFAULT_CAPABILITY_GRANTS);
    const w = world();
    w.enrol('new', FULL_DEVICE_GRANTS, false);
    expect(admit(w, terminalUse, { device: 'new' }).outcome).toBe('401 unlock_required');
    w.enrol('new');
    for (const name of Object.keys(FULL_DEVICE_GRANTS) as (keyof typeof FULL_DEVICE_GRANTS)[])
      expect(admit(w, descriptor({ capability: cap(name, 'configure') }), { device: 'new' }).outcome).toBe('admitted');
  });

  test('G136 a --limited code gives fleet.use only', () => {
    for (const [name, grant] of Object.entries(LIMITED_DEVICE_GRANTS))
      expect(grant).toEqual({ use: name === 'fleet', configure: false });
    const w = world();
    w.enrol('limited', LIMITED_DEVICE_GRANTS);
    expect(admit(w, fleetUse, { device: 'limited' }).outcome).toBe('admitted');
    expect(admit(w, fleetConfigure, { device: 'limited' }).outcome).toBe('403 grant_device_not_granted');
  });

  test('G138 the host is narrowed by neither document', () => {
    const w = world({ policy: narrowed });
    w.enrol('limited', allOff);
    for (const name of Object.keys(FULL_DEVICE_GRANTS) as (keyof typeof FULL_DEVICE_GRANTS)[])
      for (const axis of ['use', 'configure'] as const)
        expect(admit(w, descriptor({ capability: cap(name, axis) }), { bearer: ADMIN, arrival: local() }).outcome).toBe(
          'admitted',
        );
  });
});

describe('route shapes Gate decides', () => {
  test('G22 daemon update: GET is fleet.use, starting one is configure plus a step-up, turning auto-install off asks none', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('admitted');
    expect(
      admit(w, person({ method: 'POST', capability: cap('fleet', 'configure') }), { device: 'phone' }).outcome,
    ).toBe('403 grant_step_up_required');
    const off = person({ method: 'PUT', capability: cap('fleet', 'configure', { narrowing: true }) });
    expect(admit(w, off, { device: 'phone' }).outcome).toBe('admitted');
  });

  test('G23 GET …/subtree is fleet.use: a narrowed caller gets grant_not_granted before anything is read', () => {
    const w = world({ policy: offFor('fleet') });
    w.enrol('phone');
    const { outcome, call } = admit(w, fleetUse, { device: 'phone' });
    expect(outcome).toBe('403 grant_not_granted');
    expect(call.bodyRead()).toBe(false);
  });

  test('G25 harness update: GET is use, POST is configure plus a step-up, and a ferret may never start one', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const start = person({ method: 'POST', capability: cap('fleet', 'configure') });
    expect(admit(w, fleetUse, { device: 'phone' }).outcome).toBe('admitted');
    expect(admit(w, start, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
    expect(admit(w, start, ferretCall).outcome).toBe('403 owner_only');
    expect(admit(w, start, adminNamingFerret).outcome).toBe('403 owner_only');
  });

  test('G28 console input is terminal.use: ungoverned at the machine, grant plus step-up remotely, undetermined refuses', () => {
    const w = world({ policy: { ...perAct, grants: allOff } });
    expect(admit(w, terminalUse, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
    w.enrol('phone');
    expect(admit(w, terminalUse, { device: 'phone' }).outcome).toBe('403 grant_not_granted');
    w.policy = perAct;
    expect(admit(w, terminalUse, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
    w.stepUps.grant(subjectOf('phone'));
    expect(admit(w, terminalUse, { device: 'phone' }).outcome).toBe('admitted');
    w.policy = undefined;
    expect(admit(w, terminalUse, { device: 'phone' }).outcome).toBe('403 grant_undetermined');
  });

  test('G36 shared drafts are operator, no capability, person-only: every ferret is refused, a device is not narrowed', () => {
    const w = world({ policy: narrowed });
    w.enrol('phone', allOff);
    const drafts = person({ method: 'POST', path: '/v1/drafts/:id' });
    expect(admit(w, drafts, ferretCall).outcome).toBe('403 owner_only');
    expect(admit(w, drafts, adminNamingFerret).outcome).toBe('403 owner_only');
    expect(admit(w, drafts, { device: 'phone' }).outcome).toBe('admitted');
  });

  test('G37 pin and unpin are operator, no capability, person-only, so every ferret is refused', () => {
    const w = world({ policy: { ...narrowed, warden: { remote: true } } });
    const pin = person({ method: 'PUT', path: '/v1/sessions/:id/pin' });
    expect(admit(w, pin, ferretCall).outcome).toBe('403 owner_only');
    expect(admit(w, pin, { bearer: WARDEN, arrival: local() }).outcome).toBe('403 owner_only');
    expect(admit(w, pin, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
  });

  test('G38 GET of renders is operator with no capability', () => {
    const w = world({ policy: honoured });
    w.policy = { ...honoured, grants: allOff };
    w.enrol('phone', allOff);
    const renders = descriptor({ path: '/v1/renders' });
    expect(admit(w, renders, { device: 'phone' }).outcome).toBe('admitted');
    expect(admit(w, renders, ferretCall).outcome).toBe('admitted');
    expect(admit(w, renders, { bearer: WARDEN }).outcome).toBe('403 forbidden');
  });

  test('G39 the render-save locality is the carrier’s: only a ferret’s own credential or the local admin token is local', () => {
    const w = world();
    w.enrol('phone');
    const save = descriptor({ method: 'POST', path: '/v1/renders' });
    expect(standing(w, save, ferretCall).presentation?.local).toBe(true);
    expect(standing(w, save, { bearer: ADMIN, arrival: local() }).presentation?.local).toBe(true);
    expect(standing(w, save, { bearer: ADMIN, arrival: carried() }).presentation?.local).toBe(false);
    expect(standing(w, save, { device: 'phone', arrival: local() }).presentation?.local).toBe(false);
    expect(standing(w, save, { device: 'phone' }).presentation?.local).toBe(false);
  });

  test('G40 agenda actions are gated by who acts, never a capability: an agent or a warden is refused', () => {
    const w = world({ policy: { ...narrowed, warden: { remote: true } } });
    w.enrol('phone', allOff);
    const clear = person({ method: 'POST', path: '/v1/agenda/clear-agents' });
    expect(admit(w, clear, ferretCall).outcome).toBe('403 owner_only');
    expect(admit(w, clear, adminNamingFerret).outcome).toBe('403 owner_only');
    expect(admit(w, clear, { bearer: WARDEN, arrival: local() }).outcome).toBe('403 owner_only');
    expect(admit(w, clear, { device: 'phone' }).outcome).toBe('admitted');
  });

  test('G42 PUT …/seen is person-only and keyed by the credential: the device, or the local admin token', () => {
    const w = world();
    w.enrol('phone');
    const seen = person({ method: 'PUT', path: '/v1/seen' });
    expect(admit(w, seen, ferretCall).outcome).toBe('403 owner_only');
    expect(standing(w, seen, { device: 'phone' }).actor).toBe('device:phone');
    expect(standing(w, seen, { bearer: ADMIN, arrival: local() }).actor).toBe('admin-ui');
    expect(standing(w, seen, { bearer: ADMIN, arrival: local(), headers: { [CLIENT_HEADER]: 'cli' } }).actor).toBe(
      'admin-cli',
    );
  });

  test('G44 only a route that names a capability or consultsGrants is handed the grant answer; any other can only refuse', () => {
    const w = world();
    w.enrol('phone');
    const confirm = person({ method: 'POST', path: '/v1/config/confirm', consultsGrants: true });
    expect(standing(w, confirm, { device: 'phone' }).governance).toBeDefined();
    expect(standing(w, person({ method: 'POST' }), { device: 'phone' }).governance).toBeUndefined();
    expect(standing(w, fleetUse, { device: 'phone' }).governance).toBeDefined();
  });

  test('G58 secret routes demand secrets: secrets.use asks a governed caller for a step-up; the host is ungoverned', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const secretUse = descriptor({ capability: cap('secrets', 'use') });
    expect(admit(w, secretUse, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
    expect(admit(w, secretUse, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
    w.policy = offFor('secrets');
    expect(admit(w, secretUse, { device: 'phone' }).outcome).toBe('403 grant_not_granted');
  });

  test('G60 sharing.use asks a governed caller for a step-up; a ferret on the admin token may list but never write', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const write = person({ method: 'POST', capability: cap('sharing', 'use') });
    const list = descriptor({ capability: cap('sharing', 'use') });
    expect(admit(w, write, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
    expect(admit(w, write, adminNamingFerret).outcome).toBe('403 owner_only');
    expect(admit(w, list, adminNamingFerret).outcome).toBe('admitted');
  });

  test('G87 task plans are person-only; staging and committing demand terminal.configure', () => {
    const w = world({ policy: offFor('terminal') });
    w.enrol('phone');
    const stage = person({ method: 'POST', capability: cap('terminal', 'configure') });
    expect(admit(w, stage, ferretCall).outcome).toBe('403 owner_only');
    expect(admit(w, stage, { device: 'phone' }).outcome).toBe('403 grant_not_granted');
    w.policy = DEFAULT_GATE_CONFIG;
    w.enrol('limited', LIMITED_DEVICE_GRANTS);
    expect(admit(w, stage, { device: 'limited' }).outcome).toBe('403 grant_device_not_granted');
    expect(admit(w, stage, { device: 'phone' }).outcome).toBe('admitted');
  });

  test('G88 task plans: reading needs terminal.use, and revoking (a narrowing) never asks a passkey', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    expect(admit(w, terminalUse, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
    const revoke = person({ method: 'POST', capability: cap('terminal', 'use', { narrowing: true }) });
    expect(admit(w, revoke, { device: 'phone' }).outcome).toBe('admitted');
  });

  test('G91 sign-in rules are person-only on every route: a ferret gets owner_only before the body is read', () => {
    const w = world();
    for (const route of [
      person({ capability: cap('secrets', 'use') }),
      person({ method: 'POST', capability: cap('secrets', 'configure') }),
    ]) {
      const { outcome, call } = admit(w, route, ferretCall);
      expect(outcome).toBe('403 owner_only');
      expect(call.bodyRead()).toBe(false);
    }
  });

  test('G92 sign-in rules: reading, dropping, narrowing and revoking need secrets.use and never a passkey', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const narrowing = person({ method: 'DELETE', capability: cap('secrets', 'use', { narrowing: true }) });
    expect(admit(w, narrowing, { device: 'phone' }).outcome).toBe('admitted');
    w.policy = offFor('secrets');
    expect(admit(w, narrowing, { device: 'phone' }).outcome).toBe('403 grant_not_granted');
  });

  test('G93 sign-in rules: staging needs secrets.configure, decided before any proof is claimed, so a refusal spends none', () => {
    const w = world({ policy: offFor('secrets') });
    w.enrol('phone');
    const stage = 'srs_0123456789abcdef01234567' as const;
    w.stepUps.grantBound(subjectOf('phone'), STEP_UP_ACTS.approveSignInRule, stage, {
      evidence: {
        holder: holder('phone'),
        credentialId: 'c',
        clientDataJSON: 'd',
        authenticatorData: 'a',
        signature: 's',
      },
      challenge: new Uint8Array([1]),
    });
    expect(
      admit(w, person({ method: 'POST', capability: cap('secrets', 'configure') }), { device: 'phone' }).outcome,
    ).toBe('403 grant_not_granted');
    w.policy = DEFAULT_GATE_CONFIG;
    const claim = standing(w, fleetUse, { device: 'phone' }).claimStoredProof;
    expect(claim?.(STEP_UP_ACTS.approveSignInRule, stage, new Uint8Array([1]))).toBeDefined();
  });

  test('G94 a rule commit takes only the kept assertion from a paired device; the admin token on loopback holds none', () => {
    const w = world();
    w.enrol('phone');
    const stage = 'srs_0123456789abcdef01234567' as const;
    w.stepUps.grantBound(subjectOf('phone'), STEP_UP_ACTS.approveSignInRule, stage, {
      evidence: {
        holder: holder('phone'),
        credentialId: 'c',
        clientDataJSON: 'd',
        authenticatorData: 'a',
        signature: 's',
      },
      challenge: new Uint8Array([7]),
    });
    const device = standing(w, fleetUse, { device: 'phone' });
    // The kept act is never claimed as a fresh proof.
    expect(device.claimFreshStepUp?.(STEP_UP_ACTS.approveSignInRule as never, stage as never)).toBe(false);
    const owner = standing(w, fleetUse, { bearer: ADMIN, arrival: local() });
    expect(owner.claimStoredProof?.(STEP_UP_ACTS.approveSignInRule, stage, new Uint8Array([7]))).toBeUndefined();
    expect(device.claimStoredProof?.(STEP_UP_ACTS.approveSignInRule, stage, new Uint8Array([7]))).toBeDefined();
  });

  test('G109 fleet proposal apply and fleet login sit under the fleet.configure step-up, refused before the body', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const { outcome, call } = admit(w, person({ method: 'POST', capability: cap('fleet', 'configure') }), {
      device: 'phone',
    });
    expect(outcome).toBe('403 grant_step_up_required');
    expect(call.bodyRead()).toBe(false);
  });

  test('G110 starting a harness sign-in is fleet.configure with the step-up in front of it', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const signIn = person({ method: 'POST', capability: cap('fleet', 'configure') });
    expect(admit(w, signIn, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
    w.stepUps.grant(subjectOf('phone'), false);
    expect(admit(w, signIn, { device: 'phone' }).outcome).toBe('admitted');
    expect(admit(w, signIn, ferretCall).outcome).toBe('403 owner_only');
  });

  test('G130 deleting stored data is not a narrowing: it still asks per act', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const remove = person({ method: 'DELETE', capability: cap('secrets', 'configure') });
    expect(admit(w, remove, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
  });
});

describe('the step-up acts', () => {
  test('G48 minting, widening a device, sealing secrets and agent control ON each want a passkey proved for that act', () => {
    const w = world();
    w.enrol('phone');
    const acts = [
      STEP_UP_ACTS.addDevice,
      STEP_UP_ACTS.widenDevice,
      STEP_UP_ACTS.cloneSecrets,
      STEP_UP_ACTS.enableAgentControl,
    ];
    // A step-up held for no act (and the unlock) buys none of them.
    w.stepUps.grant(subjectOf('phone'));
    for (const act of acts) expect(standing(w, fleetUse, { device: 'phone' }).claimFreshStepUp?.(act)).toBe(false);
    for (const act of acts) {
      w.stepUps.grant(subjectOf('phone'), true, act);
      const claim = standing(w, fleetUse, { device: 'phone' }).claimFreshStepUp;
      for (const other of acts.filter(a => a !== act)) expect(claim?.(other)).toBe(false);
      expect(claim?.(act)).toBe(true);
    }
  });

  test('G49 turning agent control OFF asks no more than the fleet.configure step-up; only the ON half wants the passkey', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'), false);
    const save = standing(w, person({ method: 'PUT', capability: cap('fleet', 'configure') }), { device: 'phone' });
    expect(save.claimFreshStepUp?.(STEP_UP_ACTS.enableAgentControl)).toBe(false);
  });

  test('G61 minting a share needs a fresh share-catalog proof; a ferret may list but never mint', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'), true, STEP_UP_ACTS.shareLink);
    expect(standing(w, fleetUse, { device: 'phone' }).claimFreshStepUp?.(STEP_UP_ACTS.shareCatalog)).toBe(false);
    w.stepUps.grant(subjectOf('phone'), true, STEP_UP_ACTS.shareCatalog);
    expect(standing(w, fleetUse, { device: 'phone' }).claimFreshStepUp?.(STEP_UP_ACTS.shareCatalog)).toBe(true);
    const mint = person({ method: 'POST', capability: cap('sharing', 'use') });
    expect(admit(w, mint, ferretCall).outcome).toBe('403 owner_only');
    expect(admit(w, descriptor({ capability: cap('sharing', 'use') }), ferretCall).outcome).toBe('admitted');
  });

  test('G62 PUT …/new-passkey is person-only sharing.use; DELETE narrows and needs no step-up', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const put = person({ method: 'PUT', capability: cap('sharing', 'use') });
    const remove = person({ method: 'DELETE', capability: cap('sharing', 'use', { narrowing: true }) });
    expect(admit(w, put, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
    expect(admit(w, put, ferretCall).outcome).toBe('403 owner_only');
    expect(admit(w, remove, { device: 'phone' }).outcome).toBe('admitted');
  });

  test('G64 the share-link and share-catalog proofs do not buy each other’s acts', () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'), true, STEP_UP_ACTS.shareCatalog);
    expect(standing(w, fleetUse, { device: 'phone' }).claimFreshStepUp?.(STEP_UP_ACTS.shareLink)).toBe(false);
    w.stepUps.grant(subjectOf('phone'), true, STEP_UP_ACTS.shareLink);
    const claim = standing(w, fleetUse, { device: 'phone' }).claimFreshStepUp;
    expect(claim?.(STEP_UP_ACTS.shareCatalog)).toBe(false);
    expect(claim?.(STEP_UP_ACTS.shareLink)).toBe(true);
  });

  test('G65 a narrowing change to a link needs only the unlock; turning one off asks nothing more', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const off = person({ method: 'PATCH', capability: cap('sharing', 'use', { narrowing: true }) });
    expect(admit(w, off, { device: 'phone' }).outcome).toBe('admitted');
    w.enrol('locked', FULL_DEVICE_GRANTS, false);
    expect(admit(w, off, { device: 'locked' }).outcome).toBe('401 unlock_required');
  });

  test('G80 catalog install and the other add-access acts want their own proof, unlocked or not', () => {
    const w = world();
    w.enrol('phone');
    expect(standing(w, fleetUse, { device: 'phone' }).claimFreshStepUp?.(STEP_UP_ACTS.catalogInstall)).toBe(false);
    w.stepUps.grant(subjectOf('phone'), true, STEP_UP_ACTS.addDevice);
    expect(standing(w, fleetUse, { device: 'phone' }).claimFreshStepUp?.(STEP_UP_ACTS.catalogInstall)).toBe(false);
    w.stepUps.grant(subjectOf('phone'), true, STEP_UP_ACTS.catalogInstall);
    expect(standing(w, fleetUse, { device: 'phone' }).claimFreshStepUp?.(STEP_UP_ACTS.catalogInstall)).toBe(true);
  });

  test('G84 a proof bound to a staged subject opens no window and a held window is never enough for it', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    const stage = 'st_0123456789abcdef01234567' as const;
    w.stepUps.grantBound(subjectOf('phone'), STEP_UP_ACTS.addTwoFactorKey, stage);
    expect(w.stepUps.held(subjectOf('phone'))).toBe(false);
    expect(admit(w, fleetConfigure, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
    const other = { holder: holder('tablet'), session: 's-tablet' as SessionId };
    w.enrol('tablet');
    w.stepUps.grant(other);
    expect(standing(w, fleetUse, { device: 'tablet' }).claimFreshStepUp?.(STEP_UP_ACTS.addTwoFactorKey, stage)).toBe(
      false,
    );
  });

  test('G126 anything not a pure narrowing asks the live step-up; one widen proof buys one widen', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    expect(admit(w, descriptor({ capability: cap('pairing', 'configure') }), { device: 'phone' }).outcome).toBe(
      '403 grant_step_up_required',
    );
    w.stepUps.grant(subjectOf('phone'), true, STEP_UP_ACTS.widenDevice);
    const claim = standing(w, fleetUse, { device: 'phone' }).claimFreshStepUp;
    expect(claim?.(STEP_UP_ACTS.widenDevice)).toBe(true);
    expect(claim?.(STEP_UP_ACTS.widenDevice)).toBe(false);
  });

  test('G129 a loosen-config change still asks its own act, and a widen inside a grants patch still needs the machine', async () => {
    const w = world();
    w.enrol('phone');
    w.stepUps.grant(subjectOf('phone'), true, STEP_UP_ACTS.widenDevice);
    expect(standing(w, fleetUse, { device: 'phone' }).claimFreshStepUp?.(STEP_UP_ACTS.loosenConfig)).toBe(false);
    const presentation = standing(w, fleetUse, { device: 'phone' }).presentation as CapabilityPresentation;
    const svc = grants({ ...DEFAULT_CAPABILITY_GRANTS, browser: { use: false, configure: true } });
    expect(await failure(svc.patch({ browser: { use: true } }, { ...presentation, stepUp: true }))).toContain(
      'forbidden',
    );
  });

  test('G157 step-up-required is the one refusal a caller clears alone; a remote warden meets it as final', () => {
    const w = world({ policy: { ...perAct, warden: { remote: true } } });
    w.enrol('phone');
    const route = descriptor({ minimum: 'authenticated', capability: cap('warden', 'configure') });
    expect(admit(w, route, { device: 'phone' }).outcome).toBe('403 grant_step_up_required');
    w.stepUps.grant(subjectOf('phone'));
    expect(admit(w, route, { device: 'phone' }).outcome).toBe('admitted');
    // The warden has no device, so no step-up can ever be recorded for it.
    expect(admit(w, route, { bearer: WARDEN, arrival: carried() }).outcome).toBe('403 grant_step_up_required');
    expect(
      standing(w, descriptor({ minimum: 'authenticated' }), { bearer: WARDEN, arrival: carried() }).presentation
        ?.stepUp,
    ).toBe(false);
  });
});

describe('narrowing and the grant halves', () => {
  test('G68 sharing.configure governs only whether a remote caller may re-grant sharing, never sharing.use', async () => {
    const w = world({
      policy: {
        ...DEFAULT_GATE_CONFIG,
        grants: { ...DEFAULT_CAPABILITY_GRANTS, sharing: { use: true, configure: false } },
      },
    });
    w.enrol('phone');
    expect(admit(w, descriptor({ capability: cap('sharing', 'use') }), { device: 'phone' }).outcome).toBe('admitted');
    const presentation = standing(w, fleetUse, { device: 'phone' }).presentation as CapabilityPresentation;
    const svc = grants({ ...DEFAULT_CAPABILITY_GRANTS, sharing: { use: true, configure: false } });
    expect(await failure(svc.patch({ sharing: { use: false } }, { ...presentation, stepUp: true }))).toContain(
      'forbidden',
    );
    expect(await failure(svc.patch({ fleet: { use: false } }, { ...presentation, stepUp: true }))).toBe('applied');
  });

  test('G120 a device copying an axis to another device is pairing.configure with a step-up, never beyond the daemon-wide half', () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    expect(
      admit(w, person({ method: 'PATCH', capability: cap('pairing', 'configure') }), { device: 'phone' }).outcome,
    ).toBe('403 grant_step_up_required');
    const daemonWide = { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } };
    expect(intersectGrants(daemonWide, FULL_DEVICE_GRANTS).terminal).toEqual({ use: false, configure: false });
  });

  test('G121 no step-up buys a governed caller a daemon-wide off→on change', async () => {
    const off = { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: true } };
    const decision = decideCapability(cap('terminal', 'use'), {
      grants: off,
      governed: true,
      hostLocal: false,
      stepUp: true,
    });
    expect(decision).toEqual({ allowed: false, refusal: 'not-granted' });
    const remote: CapabilityPresentation = { local: false, adminToken: false, actor: 'device:phone', stepUp: true };
    expect(await failure(grants(off).patch({ terminal: { use: true } }, remote))).toContain('forbidden');
  });

  test('G125 a pure narrowing needs a proven device and no per-act step-up; the admin token off loopback and a warden are refused', () => {
    const w = world({ policy: { ...perAct, warden: { remote: true } } });
    w.enrol('phone');
    const revoke = descriptor({ minimum: 'authenticated', capability: cap('pairing', 'use', { narrowing: true }) });
    expect(admit(w, revoke, { device: 'phone' }).outcome).toBe('admitted');
    expect(admit(w, revoke, { bearer: ADMIN, arrival: carried() }).outcome).toBe('403 grant_step_up_required');
    expect(admit(w, revoke, { bearer: WARDEN, arrival: carried() }).outcome).not.toBe('admitted');
  });

  test('G134 a capability the stored grants omit reads as off, and the daemon stays closed on what it enforces', () => {
    const read = ReadCapabilityGrantsSchema.parse({ fleet: { use: true, configure: true } });
    expect(read.terminal).toEqual({ use: false, configure: false });
    const w = world({ policy: { ...DEFAULT_GATE_CONFIG, grants: read } });
    w.enrol('phone');
    expect(admit(w, terminalUse, { device: 'phone' }).outcome).toBe('403 grant_not_granted');
  });
});

describe('the rows that only appeared second', () => {
  test('G45 both axes default to enabled for every capability', () => {
    for (const grant of Object.values(DEFAULT_CAPABILITY_GRANTS)) expect(grant).toEqual({ use: true, configure: true });
    expect(GateConfigSchema.parse({}).grants).toEqual(DEFAULT_CAPABILITY_GRANTS);
  });

  test('G55 a widen refusal names the host command', async () => {
    const remote: CapabilityPresentation = { local: false, adminToken: false, actor: 'device:phone', stepUp: true };
    const off = { ...DEFAULT_CAPABILITY_GRANTS, secrets: { use: false, configure: true } };
    expect(await failure(grants(off).patch({ secrets: { use: true } }, remote))).toContain(
      '`fy daemon config set secrets --use`',
    );
  });

  test('G96 there is no operator password: gate.yaml refuses one and Gate keeps no such file', () => {
    expect(GateConfigSchema.safeParse({ operatorPassword: 'x' }).success).toBe(false);
    expect(GateConfigSchema.safeParse({ security: { ...DEFAULT_SECURITY_SETTINGS, password: 'x' } }).success).toBe(
      false,
    );
    expect(manifest.data.state.map(file => file.name).some(name => /password/iu.test(name))).toBe(false);
  });

  test('S30 a ferret is refused the store-changing routes with owner_only before the body, on its token or the admin token', () => {
    const w = world();
    const write = person({ method: 'PUT', capability: cap('secrets', 'configure') });
    for (const options of [ferretCall, adminNamingFerret]) {
      const { outcome, call } = admit(w, write, options);
      expect(outcome).toBe('403 owner_only');
      expect(call.bodyRead()).toBe(false);
    }
  });

  test('R262 a relayed request is never a loopback peer; privilegedOnly routes are unreachable through a relay', () => {
    const w = world();
    const privileged = descriptor({ privilegedOnly: true });
    expect(admit(w, privileged, { bearer: ADMIN, arrival: carried() }).outcome).toBe('403 forbidden');
    expect(
      admit(w, privileged, {
        bearer: ADMIN,
        arrival: carried(),
        clientAddress: '127.0.0.1',
        headers: { host: 'localhost' },
      }).outcome,
    ).toBe('403 forbidden');
    expect(standing(w, fleetUse, { bearer: ADMIN, arrival: carried() }).presentation?.local).toBe(false);
  });
});
