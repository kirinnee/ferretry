import { describe, it } from 'bun:test';
import { type DaemonCarrier, DaemonCarriersViewSchema } from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { carrierRoutes } from '../../../../src/lib/runtime/mounts/carriers.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, human } from './support.ts';

/**
 * The carrier refresh, driven through the real router and the real authorization boundary.
 *
 * WHAT THIS PROVES, and it is one thing: an already-paired device can ask this daemon where it can be
 * reached, WITHOUT pairing again. The published set was on the wire before this route existed, but only
 * at the one moment a device redeemed a code — so a rendezvous that changed after that left both halves
 * healthy and the room empty, and the only repair was to pair again.
 */

const CARRIERS: readonly DaemonCarrier[] = [
  { kind: 'direct', url: 'https://workstation.example.test' },
  { kind: 'relay', url: 'wss://rendezvous.example.test/fy' },
];

/** A paired browser: the caller this route is FOR. */
const DEVICE_TOKEN = 'device-secret';
const device = { authorization: `Bearer ${DEVICE_TOKEN}`, 'x-ferretry-client': 'pwa' } as const;
const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

function dispatcher(carriers: readonly DaemonCarrier[] = CARRIERS): ApiDispatcher {
  return new ApiDispatcher(
    new ApiRouter(carrierRoutes(carriers)),
    { ...CREDENTIALS, devices: { identify: token => (token === DEVICE_TOKEN ? 'device-1' : undefined) } },
    NO_GOVERNED_ROUTES_GUARD,
  );
}

async function ask(headers: Readonly<Record<string, string>>, carriers?: readonly DaemonCarrier[]) {
  return await dispatcher(carriers).dispatch(request({ path: '/v1/carriers', headers }));
}

describe('the carrier refresh mount', () => {
  it('should answer a paired device with the daemon’s whole published set', async () => {
    // Arrange / Act
    const response = await ask(device);

    // Assert — PARSED against the protocol's own view rather than compared field by field, because
    // parsing is the contract: a body this schema refuses is a body the PWA discards, and a client
    // that discards the refresh keeps dialling the rendezvous the operator switched off.
    should(response.status).equal(200);
    const view = DaemonCarriersViewSchema.parse(JSON.parse(response.body));
    should(view.carriers).deepEqual(CARRIERS);
  });

  it('should answer with the set it was given, so pairing and refresh cannot disagree', async () => {
    // THE REGRESSION THIS GUARDS. The route holds the SAME array the pairing service publishes on
    // redemption — one value the composition root resolved once. A future "optimisation" that had this
    // route recompute the set instead would pass every other case here and reintroduce exactly the
    // disagreement the published set exists to end.
    // Arrange
    const only: readonly DaemonCarrier[] = [{ kind: 'relay', url: 'wss://elsewhere.example.test/fy' }];

    // Act
    const view = DaemonCarriersViewSchema.parse(JSON.parse((await ask(device, only)).body));

    // Assert
    should(view.carriers).deepEqual(only);
  });

  it('should answer a direct-only daemon with its one carrier rather than nothing', async () => {
    // A daemon on no rendezvous is the DEFAULT install, not a fault, and it still has an address. The
    // empty answer is the shape a client cannot use: `daemonConnection` heals an empty set back to the
    // address it is already talking to, so publishing nothing would make the refresh a no-op that
    // looked like an answer.
    // Arrange
    const direct: readonly DaemonCarrier[] = [{ kind: 'direct', url: 'https://workstation.example.test' }];

    // Act
    const view = DaemonCarriersViewSchema.parse(JSON.parse((await ask(device, direct)).body));

    // Assert
    should(view.carriers).deepEqual(direct);
  });

  it('should never let a stored copy stand in for the current answer', async () => {
    // The whole value of this response is that it is current. A cached one re-serves the rendezvous the
    // operator has just switched off — the failure the route was added to end, served from the browser's
    // own disk this time.
    // Arrange / Act
    const response = await ask(device);

    // Assert
    should(response.headers.get('cache-control')).match(/no-store/u);
  });

  it('should refuse a caller this daemon has issued no credential to', async () => {
    // Arrange / Act
    const anonymous = await ask({});
    const wrongToken = await ask({ authorization: 'Bearer not-a-token' });

    // Assert — 401, not 404: the route exists, and pretending otherwise would make a stale token look
    // like an unsupported daemon and send the client down the version-skew path instead of re-pairing.
    should([anonymous.status, wrongToken.status]).deepEqual([401, 401]);
    should(anonymous.body).not.containEql('rendezvous.example.test');
  });

  it('should answer a warden too, which is the whole difference `authenticated` makes', async () => {
    // A DEVICE AND THE CLI WOULD PASS `operator` AS WELL, so neither of those proves the declaration.
    // The capability-scoped warden is the one class `authenticated` admits and `operator` refuses, and
    // it is the case that says which of the two this route actually chose. It is the right answer for
    // the same reason the grant read gives it: a supervisor watching this fleet needs to know where its
    // daemons can be reached, and no entry on this list is a secret — a rendezvous address is already
    // known to the rendezvous, and a daemon address to whoever was authorised to pair.
    // Arrange / Act
    const operator = await ask(human);
    const supervised = await ask(warden);

    // Assert
    should([operator.status, supervised.status]).deepEqual([200, 200]);
  });

  it('should never disclose a daemon fingerprint alongside the addresses', async () => {
    // The addresses are publishable and the fingerprint is not: it addresses the rendezvous, and it
    // travels in the pairing fragment where the existing rule keeps it out of anything a reader might
    // paste into an issue. `DaemonCarrierSchema` has no field for one, which is what makes this hold by
    // construction — this case is the proof that the projection did not grow one.
    // Arrange / Act
    const body = (await ask(device)).body;

    // Assert
    should(Object.keys(JSON.parse(body))).deepEqual(['carriers']);
    should(body).not.containEql('fy_daemon_');
    should(body).not.containEql('fingerprint');
  });

  it('should refuse a carrier set the wire would reject while the table is being built', async () => {
    // WHERE THE PARSE RUNS DECIDES WHAT A BAD SET LOOKS LIKE. Inside the handler it is a generic 500 on
    // every request for the life of the daemon — a daemon that reads as broken and names no remedy, and
    // a failure nobody sees until a phone asks. Here it is a boot failure, once, while somebody is still
    // looking at the terminal they started it from.
    // Arrange — addresses the TYPE permits and the schema does not: a credential in one, plaintext to a
    // rendezvous in the other.
    const credentialled: readonly DaemonCarrier[] = [
      { kind: 'direct', url: 'https://operator:hunter2@workstation.example.test' },
    ];
    const plaintextRelay: readonly DaemonCarrier[] = [{ kind: 'relay', url: 'ws://rendezvous.example.test/fy' }];

    // Act / Assert — each refusal is matched by its OWN reason. A bare `.throw()` would pass on any
    // failure at all, including one that had nothing to do with the address it was given.
    should(() => carrierRoutes(credentialled)).throw(/daemon address may not carry credentials/u);
    should(() => carrierRoutes(plaintextRelay)).throw(/must be wss\/https, or ws\/http on loopback/u);
  });

  it('should answer from one projection rather than re-deriving it per request', async () => {
    // The set is resolved at boot and constant afterwards, so there is nothing about a request that could
    // change the answer. Two calls agree byte for byte — which is also what makes the failure above a
    // boot failure rather than a recurring one.
    // Arrange
    const subject = dispatcher();

    // Act
    const first = await subject.dispatch(request({ path: '/v1/carriers', headers: device }));
    const second = await subject.dispatch(request({ path: '/v1/carriers', headers: device }));

    // Assert
    should([first.status, second.status]).deepEqual([200, 200]);
    should(first.body).equal(second.body);
  });

  it('should reach the daemon over one route and no more', async () => {
    // A refresh is a read. A mount that also offered a WRITE would let a paired phone re-point this
    // daemon's carriers at a rendezvous of its own choosing — which is a configuration change, and the
    // operator's document is the only place that decides one.
    // Arrange / Act
    const routes = carrierRoutes(CARRIERS).map(route => `${route.method} ${route.path}`);

    // Assert
    should(routes).deepEqual(['GET /v1/carriers']);
    // Neither privileged-arrival-only nor capability-gated, and both are deliberate: the remote device
    // is the reader, and an operator who switched `pairing` off to stop NEW devices being added must
    // not thereby strand the devices already paired on a rendezvous this daemon no longer dials.
    should(carrierRoutes(CARRIERS).map(route => [route.minimum, route.privilegedOnly, route.capability])).deepEqual([
      ['authenticated', undefined, undefined],
    ]);
  });
});
