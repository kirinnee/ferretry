import { expect, test } from 'bun:test';
import { cap, FULL_DEVICE_GRANTS, type CapabilityGrants } from '../../../contract/index.ts';
import { ADMIN, admit, carried, declaredRoute, local, world } from './support.ts';

/**
 * B2 / audit A fix 1, the Gate half of the launch-roots proof. Ferrets classifies a start by `presentation.local` and asks
 * `governance.decide` for `terminal.use` only outside every registered project. This runs the REAL `GateAdmission` over
 * `POST /v1/ferrets` as the shipped Ferrets manifest declares it, and pins the three standings the kernel host test
 * (`core/kernel/tests/integration/host/launch-roots-device-start.test.ts`, which cannot import Gate's daemon) stands in
 * for: a governed device holding `fleet` but not `terminal`, a device on the host's own browser, and a RELAYED caller
 * holding the admin token (relayed loopback is remote, docs/grants.md). Fixture values only.
 */

const fleetOnly: CapabilityGrants = {
  ...FULL_DEVICE_GRANTS,
  terminal: { use: false, configure: false },
} as CapabilityGrants;

const standingOf = (decision: ReturnType<typeof admit>['decision']) => {
  if (decision.outcome !== 'admitted') throw new Error('expected admitted');
  return decision.standing;
};

test('B2 a governed device with fleet but no terminal may start a ferret and is refused terminal.use', async () => {
  const w = world();
  w.enrol('phone', fleetOnly);
  const route = await declaredRoute('POST /v1/ferrets');
  const standing = standingOf(admit(w, route, { device: 'phone' }).decision);
  expect(standing.presentation).toMatchObject({ local: false });
  expect(standing.governance?.governed).toBe(true);
  expect(standing.governance?.decide(cap('fleet', 'use')).allowed).toBe(true);
  expect(standing.governance?.decide(cap('terminal', 'use')).allowed).toBe(false);
});

test('B2 a browser on the host is a device, not local: it is governed like a phone', async () => {
  const w = world();
  w.enrol('host-browser', fleetOnly);
  const route = await declaredRoute('POST /v1/ferrets');
  const standing = standingOf(admit(w, route, { device: 'host-browser', arrival: local() }).decision);
  expect(standing.presentation).toMatchObject({ local: false });
  expect(standing.governance?.decide(cap('terminal', 'use')).allowed).toBe(false);
});

test('B2 the admin token on the host is local (ungoverned); the same token carried over a relay is not local', async () => {
  const w = world();
  const route = await declaredRoute('POST /v1/ferrets');
  const onHost = standingOf(admit(w, route, { bearer: ADMIN, arrival: local() }).decision);
  expect(onHost.presentation).toMatchObject({ local: true });
  const relayed = admit(w, route, { bearer: ADMIN, arrival: carried('relay') });
  if (relayed.decision.outcome === 'admitted') {
    expect(relayed.decision.standing.presentation).toMatchObject({ local: false });
  } else {
    // Refused outright is also a remote answer: nothing relayed reaches the start as a local caller.
    expect(relayed.outcome).not.toBe('admitted');
  }
});

/**
 * The proof `scripts/validate/descriptor-parity.ts` (`RESTORED_ACTS`) names for the `consultsGrants` addition on
 * `POST /v1/ferrets`. Adding that field is NOT refusal-only in general (it hands the handler a standing it can act on), so it
 * passes the validator only here, for this one route: it restores v4, where a governed start asked the grant decision itself.
 * Granted device → the decision is reachable and says yes; ungranted device → it says no; relayed admin token → still
 * remote, never local. Without the field the same device has no standing to ask, which is the 503 it replaces.
 */
test('B2 consultsGrants on POST /v1/ferrets restores the terminal.use decision: a granted device reaches it, an ungranted device and a relayed caller stay refused', async () => {
  const w = world();
  w.enrol('terminal-phone', FULL_DEVICE_GRANTS);
  w.enrol('phone', fleetOnly);
  const route = await declaredRoute('POST /v1/ferrets');
  expect(route.consultsGrants).toBe(true);

  const granted = standingOf(admit(w, route, { device: 'terminal-phone' }).decision);
  expect(granted.governance?.governed).toBe(true);
  expect(granted.governance?.decide(cap('terminal', 'use')).allowed).toBe(true);

  const ungranted = standingOf(admit(w, route, { device: 'phone' }).decision);
  expect(ungranted.governance?.decide(cap('terminal', 'use')).allowed).toBe(false);

  const relayed = admit(w, route, { bearer: ADMIN, arrival: carried('relay') });
  if (relayed.decision.outcome === 'admitted')
    expect(relayed.decision.standing.presentation).toMatchObject({ local: false });
  else expect(relayed.outcome).not.toBe('admitted');

  // The regression it replaces: without the field the same granted device carries no standing to ask the decision of.
  const without = { ...route, consultsGrants: undefined } as typeof route;
  expect(standingOf(admit(w, without, { device: 'terminal-phone' }).decision).governance).toBeUndefined();
});
