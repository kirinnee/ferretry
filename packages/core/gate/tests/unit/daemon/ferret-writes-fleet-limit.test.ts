import { expect, test } from 'bun:test';
import { FULL_DEVICE_GRANTS, LIMITED_DEVICE_GRANTS, type CapabilityGrants } from '../../../contract/index.ts';
import { ADMIN, admit, carried, declaredRoute, FERRET_TOKEN, local, world } from './support.ts';

/**
 * c58-sec3: the fleet capability limit is real on every ferret write (owner ruling on !A538, choice (a)). The REAL
 * `GateAdmission` over each route AS THE SHIPPED manifests declare it (`declaredRoute` loads every manifest, so a descriptor
 * that loses its demand fails here; the route-table half is `core/ferrets/tests/unit/fleet-write-capability.test.ts`).
 *
 *  - `fleet.use` gates send, interrupt, the ledger and queue writes, shared drafts, stop, resume, rename, signal and pin;
 *  - `fleet.configure` gates fork, move, handover (+ cancel, ask-to-stop-jobs), conversion-preview, start, revoke-credential
 *    and the restart queue.
 *
 * A device with the axis off is refused with `grant_device_not_granted` before the body is read; the default device and a
 * `--limited` one (fleet use only) still do every `fleet.use` act; the owner's loopback admin token is never refused; the
 * same admin token carried over a relay is REMOTE (the carrier decides, never an address), and a device whose request
 * carries a loopback-looking address is refused all the same.
 */

const USE_WRITES = [
  'POST /v1/ferrets/:ferretId/send',
  'POST /v1/ferrets/:ferretId/interrupt',
  'POST /v1/ferrets/:ferretId/sends/:sendId/retry',
  'POST /v1/ferrets/:ferretId/sends/:sendId/cancel',
  'POST /v1/ferrets/:ferretId/sends/:sendId/enter',
  'PATCH /v1/ferrets/:ferretId/queue/:messageId',
  'DELETE /v1/ferrets/:ferretId/queue/:messageId',
  'GET /v1/ferrets/:ferretId/shared-draft',
  'POST /v1/ferrets/:ferretId/shared-draft',
  'GET /v1/ferrets/:ferretId/shared-draft/stream',
  'POST /v1/ferrets/:ferretId/stop',
  'POST /v1/ferrets/:ferretId/resume',
  'POST /v1/ferrets/:ferretId/rename',
  'POST /v1/ferrets/:ferretId/signal',
  'POST /v1/ferrets/:ferretId/pin',
  'POST /v1/ferrets/:ferretId/unpin',
  'POST /v1/ferrets/:ferretId/pins',
] as const;

const CONFIGURE_WRITES = [
  'POST /v1/ferrets',
  'POST /v1/ferrets/:ferretId/fork',
  'POST /v1/ferrets/:ferretId/move',
  'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs',
  'POST /v1/ferrets/:ferretId/handover',
  'POST /v1/ferrets/:ferretId/handover/cancel',
  'POST /v1/ferrets/:ferretId/conversion-preview',
  'POST /v1/ferrets/:ferretId/revoke-credential',
  'POST /v1/restarts',
  'DELETE /v1/restarts',
  // r1: every OTHER door that starts a ferret asks what `POST /v1/ferrets` asks (the explicit list is
  // `core/ferrets/tests/unit/fleet-write-capability.test.ts`, OUTSIDE_FERRETS).
  'POST /v1/ferrets/:id/runtime',
  'POST /v1/board/cards/:cardId/start',
  'POST /v1/lessons/run',
  'POST /v1/lessons/scan',
  'POST /v1/pack/routing/clean-up',
] as const;

const NO_FLEET_USE: CapabilityGrants = {
  ...FULL_DEVICE_GRANTS,
  fleet: { use: false, configure: false },
} as CapabilityGrants;
const FLEET_USE_ONLY: CapabilityGrants = {
  ...LIMITED_DEVICE_GRANTS,
  fleet: { use: true, configure: false },
} as CapabilityGrants;
const NO_FLEET_CONFIGURE: CapabilityGrants = {
  ...FULL_DEVICE_GRANTS,
  fleet: { use: true, configure: false },
} as CapabilityGrants;

for (const key of USE_WRITES) {
  test(`c58-sec3 ${key} asks fleet.use: a device narrowed off it is refused before the body is read; the default and a --limited device are served`, async () => {
    const route = await declaredRoute(key);
    expect(route.capability).toMatchObject({ capability: 'fleet', axis: 'use' });
    const w = world();
    w.enrol('narrowed', NO_FLEET_USE);
    w.enrol('full', FULL_DEVICE_GRANTS);
    w.enrol('limited', FLEET_USE_ONLY);
    w.enrol('limited-pair', LIMITED_DEVICE_GRANTS);
    const refused = admit(w, route, { device: 'narrowed' });
    expect(refused.outcome).toBe('403 grant_device_not_granted');
    expect(refused.call.bodyRead()).toBe(false);
    // The same device from a request that looks like loopback is still remote: the carrier decides, never the address.
    expect(admit(w, route, { device: 'narrowed', clientAddress: '127.0.0.1' }).outcome).toBe(
      '403 grant_device_not_granted',
    );
    expect(admit(w, route, { device: 'full' }).outcome).toBe('admitted');
    expect(admit(w, route, { device: 'limited' }).outcome).toBe('admitted');
    expect(admit(w, route, { device: 'limited-pair' }).outcome).toBe('admitted');
  });

  test(`c58-sec3 ${key} is never refused to the owner's loopback admin token, and the same token over a relay is remote`, async () => {
    const route = await declaredRoute(key);
    const w = world();
    expect(admit(w, route, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
    const relayed = admit(w, route, { bearer: ADMIN, arrival: carried('relay') });
    // A `use` act is served to the relayed admin token as a REMOTE caller (never as the host).
    expect(relayed.outcome).toBe('admitted');
    if (relayed.decision.outcome !== 'admitted') throw new Error('unreachable: asserted admitted above');
    expect(relayed.decision.standing.presentation).toMatchObject({ local: false });
  });
}

for (const key of CONFIGURE_WRITES) {
  test(`c58-sec3 ${key} asks fleet.configure: a device without it (a --limited one included) is refused before the body is read; the default device is served`, async () => {
    const route = await declaredRoute(key);
    expect(route.capability).toMatchObject({ capability: 'fleet', axis: 'configure' });
    const w = world();
    w.enrol('narrowed', NO_FLEET_USE);
    w.enrol('no-configure', NO_FLEET_CONFIGURE);
    w.enrol('limited', FLEET_USE_ONLY);
    w.enrol('limited-pair', LIMITED_DEVICE_GRANTS);
    w.enrol('full', FULL_DEVICE_GRANTS);
    for (const device of ['narrowed', 'no-configure', 'limited', 'limited-pair']) {
      const refused = admit(w, route, { device });
      expect(refused.outcome).toBe('403 grant_device_not_granted');
      expect(refused.call.bodyRead()).toBe(false);
    }
    expect(admit(w, route, { device: 'no-configure', clientAddress: '127.0.0.1' }).outcome).toBe(
      '403 grant_device_not_granted',
    );
    expect(admit(w, route, { device: 'full' }).outcome).toBe('admitted');
  });

  test(`c58-sec3 ${key} asks the live step-up of a governed caller whose device is locked`, async () => {
    const route = await declaredRoute(key);
    const w = world();
    w.enrol('locked', FULL_DEVICE_GRANTS, false);
    expect(admit(w, route, { device: 'locked' }).outcome).not.toBe('admitted');
  });

  test(`c58-sec3 ${key} is never refused to the owner's loopback admin token, and the same token over a relay is remote`, async () => {
    const route = await declaredRoute(key);
    const w = world();
    expect(admit(w, route, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
    // A `configure` act over a relay is a remote one: the admin token alone is not the host, so it asks the step-up.
    expect(admit(w, route, { bearer: ADMIN, arrival: carried('relay') }).outcome).toBe('403 grant_step_up_required');
  });
}

// A ferret's own credential is never grant-governed (4.x parity): on a route open to a ferret it is admitted as that
// ferret; a person's route (fork, revoke-credential, the sidebar pin, retry, the shared draft) refuses it at the boundary.
test('c58-sec3 a ferret credential is not governed by the fleet limit: admitted on a caller-any write, refused on a person-only one', async () => {
  const w = world();
  for (const key of [...USE_WRITES, ...CONFIGURE_WRITES]) {
    const route = await declaredRoute(key);
    const asFerret = admit(w, route, { bearer: FERRET_TOKEN, arrival: local(true) });
    if (route.caller === 'any') expect(asFerret.outcome).toBe('admitted');
    else expect(asFerret.outcome).not.toBe('admitted');
  }
});
