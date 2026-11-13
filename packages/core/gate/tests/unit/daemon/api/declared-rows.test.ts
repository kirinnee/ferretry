import { describe, expect, test } from 'bun:test';
import { cap, DEFAULT_GATE_CONFIG, DEFAULT_GATE_SECURITY, FULL_DEVICE_GRANTS } from '../../../../contract/index.ts';
import { ADMIN, admit, carried, declaredRoute, FERRET_TOKEN, local, WARDEN, world } from '../support.ts';
import type { ScopedRoute } from '@ferretry/kernel/contract';

/**
 * Rows Gate pins against the descriptors the SHIPPED manifests declare, not a hand-built stand-in: if a route moves
 * or its descriptor changes, these fail by naming it.
 */

const perAct = { ...DEFAULT_GATE_CONFIG, security: { ...DEFAULT_GATE_SECURITY, stepUpOnActions: true } };
const remoteWarden = { ...DEFAULT_GATE_CONFIG, warden: { remote: true } };
const ferretCall = { bearer: FERRET_TOKEN, arrival: local(true) };

describe('warden', () => {
  test('G21 POST /v1/warden/leave is warden.configure: a device steps up for it, and a remote warden is refused', async () => {
    const leave = await declaredRoute('POST /v1/warden/leave');
    expect(leave.capability).toEqual(cap('warden', 'configure'));
    expect(leave.caller).toBe('person');

    // A governed device: nothing until it unlocks; then granted, and a step-up only where per-act confirmation is on.
    const w = world();
    w.enrol('locked', FULL_DEVICE_GRANTS, false);
    w.enrol('phone');
    expect(admit(w, leave, { device: 'locked', method: 'POST' }).outcome).toBe('401 unlock_required');
    expect(admit(w, leave, { device: 'phone', method: 'POST' }).outcome).toBe('admitted');
    w.policy = perAct;
    expect(admit(w, leave, { device: 'phone', method: 'POST' }).outcome).toBe('403 grant_step_up_required');
    w.stepUps.grant({ deviceId: 'phone', appSession: 's-phone' });
    expect(admit(w, leave, { device: 'phone', method: 'POST' }).outcome).toBe('admitted');

    // Revoking the device's warden.configure grant takes it away, whatever the unlock.
    w.enrol('narrow', { ...FULL_DEVICE_GRANTS, warden: { use: true, configure: false } });
    w.policy = DEFAULT_GATE_CONFIG;
    expect(admit(w, leave, { device: 'narrow', method: 'POST' }).outcome).toBe('403 grant_device_not_granted');

    // A warden can never quiet its own or anyone's supervision. Off this host its token is not even honoured unless
    // gate.yaml says a remote warden is; once honoured it is not a person, so the route is refused all the same.
    const post = { bearer: WARDEN, method: 'POST' };
    expect(admit(world(), leave, { ...post, arrival: local() }).outcome).toBe('403 owner_only');
    expect(admit(world(), leave, { ...post, arrival: carried() }).outcome).toBe('401 unauthorized');
    expect(admit(world({ policy: remoteWarden }), leave, { ...post, arrival: carried() }).outcome).toBe(
      '403 owner_only',
    );

    // A ferret is a person's act refused; the owner at the machine is served.
    expect(admit(w, leave, { ...ferretCall, method: 'POST' }).outcome).toBe('403 owner_only');
    expect(admit(w, leave, { bearer: ADMIN, arrival: local(), method: 'POST' }).outcome).toBe('admitted');
  });
});

describe('download links', () => {
  test('G66 a ferret may list and read download links but never preview, make, copy, move, change or turn one off', async () => {
    const reads = ['GET /v1/catalog-links', 'GET /v1/catalog-links/:linkId'];
    const writes = [
      'POST /v1/catalog-links/preview',
      'POST /v1/catalog-links',
      'POST /v1/catalog-links/:linkId/copy',
      'PUT /v1/catalog-links/:linkId/version',
      'PATCH /v1/catalog-links/:linkId',
      'DELETE /v1/catalog-links/:linkId',
    ];
    const w = world();
    for (const key of reads) {
      const route = await declaredRoute(key);
      expect(route.capability).toEqual(cap('sharing', 'use'));
      expect(admit(w, route, ferretCall).outcome).toBe('admitted');
    }
    for (const key of writes) {
      const route = await declaredRoute(key);
      expect(admit(w, route, ferretCall).outcome).toBe('403 owner_only');
    }
  });
});

describe('narrowing', () => {
  /** The 5.0 spelling of every route G128a–G128i names (each is tested by the plugin that serves it). */
  const NARROWING_ROUTES = [
    'POST /v1/ferrets/:ferretId/task-plans/:planId/revoke', // plan revoke
    'POST /v1/sign-in-rules/:id/narrow', // sign-in rule narrow
    'DELETE /v1/sign-in-rules/:id', // sign-in rule revoke
    'POST /v1/accounts/:id/sign-in-rules/revoke', // sign-in rules revoked for an account
    'DELETE /v1/copy-rules/:ruleId', // paste-rule delete
    'DELETE /v1/copy-rules/stages/:stage', // paste-rule drop
    'PUT /v1/accounts/defaults', // removing a default account
    'DELETE /v1/pair/devices/:deviceId', // device revoke
    'PATCH /v1/pair/devices/:deviceId/grants', // device grants patch
  ] as const;

  test('G127 every route G128a–G128i names is declared narrowing, so a governed device is not asked to step up again', async () => {
    const w = world({ policy: perAct });
    w.enrol('phone');
    for (const key of NARROWING_ROUTES) {
      const route = await declaredRoute(key);
      expect(route.capability?.narrowing).toBe(true);
      expect(admit(w, route, { device: 'phone', method: route.method }).outcome).toBe('admitted');
      // The same route, un-declared as narrowing, asks (so "no ask" is the declaration's doing).
      const widening = {
        ...route,
        capability: { ...route.capability, narrowing: undefined },
      } as unknown as ScopedRoute;
      expect(admit(w, widening, { device: 'phone', method: route.method }).outcome).toBe('403 grant_step_up_required');
    }
  });

  test('G127 a narrowing route still needs the grant: narrowing never asks again, it does not skip the operator', async () => {
    const route = await declaredRoute('DELETE /v1/pair/devices/:deviceId');
    const w = world({ policy: { ...perAct, grants: { ...perAct.grants, pairing: { use: false, configure: false } } } });
    w.enrol('phone');
    // The operator's switch is read after the narrowing relief, so a turned-off capability is still refused.
    const outcome = admit(w, route, { device: 'phone', method: 'DELETE' }).outcome;
    expect(outcome).toBe('403 grant_not_granted');
  });
});
