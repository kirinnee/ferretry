import { expect, test } from 'bun:test';
import { ferretOf, FULL_DEVICE_GRANTS, LIMITED_DEVICE_GRANTS, type CapabilityGrants } from '../../../contract/index.ts';
import { ADMIN, admit, carried, declaredRoute, FERRET, FERRET_TOKEN, local, world } from './support.ts';

/**
 * c58-sec2: writing a ferret's pin board is `fleet.use`, like reading it (c58-sec1). The REAL `GateAdmission` over the route
 * AS THE SHIPPED Ferrets manifest declares it (`declaredRoute` loads the manifest, so a descriptor that loses its demand
 * fails here). `POST /v1/ferrets/:ferretId/pins` is the ONE route that adds, edits and removes a note or message pin (the
 * body's `action`); there is no PATCH or DELETE pin route. A device the owner narrowed to no fleet use is refused with
 * `grant_device_not_granted` before the body is read; a device that holds it, the owner at the machine over loopback and a
 * ferret's own credential (never grant-governed) are admitted exactly as before.
 */

const PIN_WRITES = ['POST /v1/ferrets/:ferretId/pins'] as const;

const NO_FLEET_USE: CapabilityGrants = {
  ...FULL_DEVICE_GRANTS,
  fleet: { use: false, configure: false },
} as CapabilityGrants;
const FLEET_USE_ONLY: CapabilityGrants = {
  ...LIMITED_DEVICE_GRANTS,
  fleet: { use: true, configure: false },
} as CapabilityGrants;

for (const key of PIN_WRITES) {
  test(`c58-sec2 ${key} asks fleet.use: a device narrowed off it is refused before the body is read, a holder is admitted`, async () => {
    const route = await declaredRoute(key);
    expect(route.capability).toMatchObject({ capability: 'fleet', axis: 'use' });
    const w = world();
    w.enrol('narrowed', NO_FLEET_USE);
    w.enrol('full', FULL_DEVICE_GRANTS);
    w.enrol('limited', FLEET_USE_ONLY);
    const refused = admit(w, route, { device: 'narrowed' });
    expect(refused.outcome).toBe('403 grant_device_not_granted');
    expect(refused.call.bodyRead()).toBe(false);
    expect(admit(w, route, { device: 'full' }).outcome).toBe('admitted');
    expect(admit(w, route, { device: 'limited' }).outcome).toBe('admitted');
  });

  test(`c58-sec2 ${key} still admits the owner's loopback admin token and a ferret's own credential as that ferret`, async () => {
    const route = await declaredRoute(key);
    const w = world();
    expect(admit(w, route, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
    const asFerret = admit(w, route, { bearer: FERRET_TOKEN, arrival: local(true) });
    if (asFerret.decision.outcome !== 'admitted') throw new Error(`expected a ferret bearer admitted to ${key}`);
    expect(
      ferretOf({ credential: asFerret.decision.standing.credential, actor: asFerret.decision.standing.actor }),
    ).toBe(FERRET);
    expect(asFerret.decision.standing.presentation).toMatchObject({ local: true });
  });

  test(`c58-sec2 ${key}: the admin token carried over a relay is remote, so a narrowed grant refuses it`, async () => {
    const route = await declaredRoute(key);
    const w = world();
    const relayed = admit(w, route, { bearer: ADMIN, arrival: carried('relay') });
    // Never admitted as a local caller: either refused outright or admitted governed, never `local`.
    if (relayed.decision.outcome === 'admitted')
      expect(relayed.decision.standing.presentation).toMatchObject({ local: false });
    else expect(relayed.outcome).not.toBe('admitted');
  });
}

// The owner's sidebar pin and unpin answer the ferret's WHOLE identity record (folder, login, transcript location, attribution
// token) and take any ferret by name or id, so they are a read of a ferret too: a device narrowed off fleet use must not get
// that record through them, nor revive an archived ferret. `caller: 'person'` keeps every ferret out (the pin is a person's act).
const SIDEBAR_PINS = ['POST /v1/ferrets/:ferretId/pin', 'POST /v1/ferrets/:ferretId/unpin'] as const;

for (const key of SIDEBAR_PINS) {
  test(`c58-sec2 ${key} asks fleet.use: a device narrowed off it is refused before the body is read, a holder is admitted`, async () => {
    const route = await declaredRoute(key);
    expect(route.capability).toMatchObject({ capability: 'fleet', axis: 'use' });
    expect(route.caller).toBe('person');
    const w = world();
    w.enrol('narrowed', NO_FLEET_USE);
    w.enrol('full', FULL_DEVICE_GRANTS);
    w.enrol('limited', FLEET_USE_ONLY);
    const refused = admit(w, route, { device: 'narrowed' });
    expect(refused.outcome).toBe('403 grant_device_not_granted');
    expect(refused.call.bodyRead()).toBe(false);
    expect(admit(w, route, { device: 'full' }).outcome).toBe('admitted');
    expect(admit(w, route, { device: 'limited' }).outcome).toBe('admitted');
  });

  test(`c58-sec2 ${key} still admits the owner's loopback admin token and still refuses a ferret's own credential`, async () => {
    const route = await declaredRoute(key);
    const w = world();
    expect(admit(w, route, { bearer: ADMIN, arrival: local() }).outcome).toBe('admitted');
    expect(admit(w, route, { bearer: FERRET_TOKEN, arrival: local(true) }).outcome).not.toBe('admitted');
  });
}
