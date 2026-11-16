import { expect, test } from 'bun:test';
import { ferretOf, FULL_DEVICE_GRANTS, LIMITED_DEVICE_GRANTS, type CapabilityGrants } from '../../../contract/index.ts';
import { ADMIN, admit, carried, declaredRoute, FERRET, FERRET_TOKEN, local, request, world } from './support.ts';

/**
 * c58-sec1: reading a ferret's record is `fleet.use`. The REAL `GateAdmission` over each route and the journal socket AS THE
 * SHIPPED Ferrets manifest declares them (`declaredRoute` loads the manifest, so a descriptor that loses its demand fails
 * here): a device the owner narrowed to no fleet use is refused with `grant_device_not_granted` before anything is read, a
 * device that holds it (every default device, and a `--limited` one) is admitted, the owner at the machine is ungoverned,
 * and a ferret's own credential is admitted as that ferret (grants never govern it: 4.x parity, the agent half is the
 * handler's and is pinned in `core/kernel/tests/integration/host/ferret-reads-agent.test.ts`).
 *
 * Why two halves: the kernel cannot import Gate's daemon and Gate cannot import the Ferrets half (`context-imports`), so
 * the real admission and the real handlers meet only in the shipped descriptor, which this reads.
 */

const FERRET_READS = [
  'GET /v1/ferrets',
  'GET /v1/ferrets/:ferretId',
  'GET /v1/ferrets/by-request/:requestId',
  'GET /v1/archived-sessions',
  'GET /v1/ferrets/:ferretId/pins',
  'GET /v1/restarts',
  'GET /v1/ferrets/:ferretId/handover',
  'GET /v1/ferrets/:ferretId/relaunch-settings',
  // Declared by PLUGIN manifests (Conversation, Packs, Lessons): `declaredRoute` loads every manifest, so the same table
  // holds them. What a ferret said, was sent, asked or reported, and the directory that names every ferret.
  'GET /v1/ferrets/:ferretId/logs',
  'GET /v1/ferrets/:ferretId/log-page',
  'GET /v1/ferrets/:ferretId/log-search',
  'GET /v1/ferrets/:ferretId/messages',
  'GET /v1/ferrets/:ferretId/question',
  'GET /v1/ferrets/:ferretId/sends',
  'GET /v1/ferrets/:ferretId/queue',
  'GET /v1/ferrets/:ferretId/sends/:sendId',
  'GET /v1/ferrets/:ferretId/handoffs/:name',
  'GET /v1/ferrets/:ferretId/transcript-images/:handle',
  'GET /v1/ferrets/:ferretId/attachments/:attachmentId',
  'GET /v1/ferrets/:ferretId/result',
  'GET /v1/lessons/directory',
] as const;

const NO_FLEET_USE: CapabilityGrants = {
  ...FULL_DEVICE_GRANTS,
  fleet: { use: false, configure: false },
} as CapabilityGrants;
const FLEET_USE_ONLY: CapabilityGrants = {
  ...LIMITED_DEVICE_GRANTS,
  fleet: { use: true, configure: false },
} as CapabilityGrants;

for (const key of FERRET_READS) {
  test(`c58-sec1 ${key} asks fleet.use: a device narrowed off it is refused, a device holding it is admitted`, async () => {
    const route = await declaredRoute(key);
    expect(route.capability).toMatchObject({ capability: 'fleet', axis: 'use' });
    const w = world();
    w.enrol('narrowed', NO_FLEET_USE);
    w.enrol('full', FULL_DEVICE_GRANTS);
    w.enrol('limited', FLEET_USE_ONLY);
    expect(admit(w, route, { device: 'narrowed' }).outcome).toBe('403 grant_device_not_granted');
    expect(admit(w, route, { device: 'full' }).outcome).toBe('admitted');
    expect(admit(w, route, { device: 'limited' }).outcome).toBe('admitted');
  });

  test(`c58-sec1 ${key} still admits the owner's loopback admin token and a ferret's own credential as that ferret`, async () => {
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

  test(`c58-sec1 ${key}: the admin token carried over a relay is remote, so a narrowed grant refuses it`, async () => {
    const route = await declaredRoute(key);
    const w = world();
    const relayed = admit(w, route, { bearer: ADMIN, arrival: carried('relay') });
    // Never admitted as a local caller: either refused outright or admitted governed, never `local`.
    if (relayed.decision.outcome === 'admitted')
      expect(relayed.decision.standing.presentation).toMatchObject({ local: false });
    else expect(relayed.outcome).not.toBe('admitted');
  });
}

test('c58-sec1 GET /v1/events (the journal socket) asks fleet.use: a narrowed device is refused, a holder is admitted', async () => {
  const route = await declaredRoute('GET /v1/events');
  expect(route.capability).toMatchObject({ capability: 'fleet', axis: 'use' });
  const w = world();
  w.enrol('narrowed', NO_FLEET_USE);
  w.enrol('full', FULL_DEVICE_GRANTS);
  const admitted = (device: string) =>
    w.gate.admit({
      table: 'socket',
      descriptor: route,
      request: request({ method: 'GET', path: '/v1/events', device }),
      params: new Map(),
    });
  const narrowed = admitted('narrowed');
  expect(narrowed.outcome).toBe('refused');
  if (narrowed.outcome === 'refused')
    expect(JSON.parse(String(narrowed.response.body))).toMatchObject({ code: 'grant_device_not_granted' });
  expect(admitted('full').outcome).toBe('admitted');
  expect(
    w.gate.admit({
      table: 'socket',
      descriptor: route,
      request: request({ method: 'GET', path: '/v1/events', bearer: ADMIN, arrival: local() }),
      params: new Map(),
    }).outcome,
  ).toBe('admitted');
});

test('c58-sec1 a request that carries the narrowed device names no ferret: the read is refused before the handler could answer', async () => {
  const w = world();
  w.enrol('narrowed', NO_FLEET_USE);
  const route = await declaredRoute('GET /v1/ferrets/:ferretId');
  const decision = admit(w, route, { device: 'narrowed' });
  expect(decision.decision.outcome).toBe('refused');
  // Admission decided before any body or handler: nothing was read.
  expect(decision.call.bodyRead()).toBe(false);
});
