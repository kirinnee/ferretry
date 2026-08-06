/**
 * What a paired daemon's carriers are, what survives a reload, and what does not.
 *
 * Three claims are load-bearing and none of them is visible from a coverage number,
 * because each is a single condition on a single line:
 *
 *   1. Every direct is ordered before every relay, and a relay is offered only for a
 *      fingerprint a rendezvous can actually address.
 *   2. The daemon-published set survives a reload and replaces the previous set whole;
 *      the old singular hosted guess is not promoted into that authoritative cache.
 *   3. The event stream REFUSES on a relayed carrier rather than opening a socket at
 *      an address the relay exists because the browser cannot reach.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  CONNECTIONS_KEY,
  CONNECTIONS_VERSION,
  DaemonConnectionStore,
  parseDaemonConnections,
} from '../../src/lib/connections.ts';
import {
  daemonCarriers,
  daemonConnection,
  hostedRelayFallbackCarrier,
  type RelayCarrier,
} from '../../src/lib/daemon-connection.ts';
import { DaemonEventTransport, daemonEventTicket, RELAY_STREAM_UNSUPPORTED } from '../../src/lib/event-transport.ts';

const FINGERPRINT = `fy_daemon_${'A'.repeat(43)}`;
const DAEMON_URL = 'https://studio.example';
const SELF_RELAY: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay.mine', operator: 'self' };
const HOSTED_RELAY: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay.ferretry', operator: 'hosted' };

const connection = (daemonId: string, relays: readonly RelayCarrier[] = []) =>
  daemonConnection({
    daemonId,
    baseUrl: DAEMON_URL,
    deviceToken: 'fy_device_x',
    carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, ...relays],
  });

const stored = (relay: unknown) =>
  JSON.stringify({
    v: CONNECTIONS_VERSION,
    selectedDaemonId: FINGERPRINT,
    connections: [
      { daemonId: FINGERPRINT, baseUrl: DAEMON_URL, deviceToken: 'fy_device_x', pairedAt: 1, lastSelectedAt: 2, relay },
    ],
  });

const storedCarriers = (carriers: unknown) =>
  JSON.stringify({
    v: CONNECTIONS_VERSION,
    selectedDaemonId: FINGERPRINT,
    connections: [
      {
        daemonId: FINGERPRINT,
        baseUrl: DAEMON_URL,
        deviceToken: 'fy_device_x',
        pairedAt: 1,
        lastSelectedAt: 2,
        carriers,
      },
    ],
  });

describe('the carriers one paired daemon has', () => {
  it('should order direct first and name the relay second', () => {
    should(daemonCarriers(connection(FINGERPRINT, [HOSTED_RELAY]))).eql([
      { kind: 'direct', daemonUrl: DAEMON_URL },
      HOSTED_RELAY,
    ]);
  });

  it('should offer direct only when nothing advertised a relay', () => {
    should(daemonCarriers(connection(FINGERPRINT))).eql([{ kind: 'direct', daemonUrl: DAEMON_URL }]);
  });

  it('should refuse a relay for a fingerprint no rendezvous can address', () => {
    // A rendezvous is addressed by the fingerprint (§4) and the handshake is checked
    // against that same string (§6). Any other spelling has nothing to verify against,
    // and a session keyed against an unverifiable fingerprint is the whole attack.
    should(daemonCarriers(connection('sha256:legacy-spelling', [HOSTED_RELAY]))).eql([
      { kind: 'direct', daemonUrl: DAEMON_URL },
    ]);
  });

  it('should refuse a relay address this browser may not dial', () => {
    should(() => connection(FINGERPRINT, [{ kind: 'relay', relayUrl: 'http://not-loopback.example' }])).throw(
      /not a dialable rendezvous/u,
    );
  });
});

describe('a stored pairing registry', () => {
  it('should restore a relay its owner supplied, including one written before the operator field', () => {
    should(parseDaemonConnections(stored(SELF_RELAY)).connections[0]?.carriers).eql([
      { kind: 'direct', daemonUrl: DAEMON_URL },
      SELF_RELAY,
    ]);
    should(
      parseDaemonConnections(stored({ kind: 'relay', relayUrl: 'https://relay.mine' })).connections[0]?.carriers,
    ).eql([{ kind: 'direct', daemonUrl: DAEMON_URL }, SELF_RELAY]);
  });

  /**
   * The other half of the rule above, and the reason it is safe.
   *
   * A daemon too old to publish a set cannot say where it can be reached, and the stored record from
   * the previous model names only the direct address the pairing arrived on. Refusing that daemon the
   * hosted address as well would take away the path a phone off its network has always used, with no
   * connection left that could ever teach it back — the refresh needs one and pairing is direct-only.
   * So the address is offered per DIAL and never written down: nothing here returns a value a reload
   * could inherit, which is what keeps `relayUrl: null` an immediate kill switch.
   */
  it('should offer the current hosted address to a daemon that has authored no rendezvous', () => {
    should(hostedRelayFallbackCarrier(connection(FINGERPRINT), HOSTED_RELAY.relayUrl)).eql(HOSTED_RELAY);
  });

  it('should offer nothing when the daemon authored a rendezvous of its own', () => {
    // The daemon SAID where it can be reached, and its answer is the whole answer: adding an address
    // it did not name would be this browser second-guessing the authority it just read.
    should(hostedRelayFallbackCarrier(connection(FINGERPRINT, [SELF_RELAY]), HOSTED_RELAY.relayUrl)).be.undefined();
    should(hostedRelayFallbackCarrier(connection(FINGERPRINT, [HOSTED_RELAY]), HOSTED_RELAY.relayUrl)).be.undefined();
  });

  it('should offer nothing once the directory withdraws the address, and nothing to dial without one', () => {
    // `relayUrl: null`, a directory this page could not reach, and a build carrying no directory at
    // all arrive here identically: as no address. None of the three is permission to guess.
    should(hostedRelayFallbackCarrier(connection(FINGERPRINT), undefined)).be.undefined();
  });

  it('should offer nothing to a fingerprint no rendezvous can address, whoever runs it', () => {
    // Same rule `daemonCarriers` draws for a published relay, and for the same reason: a session
    // keyed against an unverifiable fingerprint is the attack, not a fallback that failed politely.
    should(hostedRelayFallbackCarrier(connection('sha256:legacy-spelling'), HOSTED_RELAY.relayUrl)).be.undefined();
  });

  it('should refuse an advertised address this browser may not dial', () => {
    // Parsed rather than trusted, by the protocol's own endpoint rule — plaintext to a stranger's
    // service is not a carrier this browser will open whatever the directory says.
    should(hostedRelayFallbackCarrier(connection(FINGERPRINT), 'http://plaintext.example')).be.undefined();
    should(hostedRelayFallbackCarrier(connection(FINGERPRINT), 'not a url')).be.undefined();
  });

  it('should not promote the old client-discovered hosted relay into the daemon-authored cache', () => {
    should(parseDaemonConnections(stored(HOSTED_RELAY)).connections[0]?.carriers).eql([
      { kind: 'direct', daemonUrl: DAEMON_URL },
    ]);
  });

  it('should restore every carrier from a daemon-published set, including multiple relays', () => {
    const second = { kind: 'relay' as const, relayUrl: 'https://relay.second', operator: 'self' as const };
    should(
      parseDaemonConnections(storedCarriers([{ kind: 'direct', daemonUrl: DAEMON_URL }, HOSTED_RELAY, second]))
        .connections[0]?.carriers,
    ).eql([{ kind: 'direct', daemonUrl: DAEMON_URL }, HOSTED_RELAY, second]);
  });

  it('should discard one damaged cached carrier without erasing the pairing record', () => {
    should(
      parseDaemonConnections(
        storedCarriers([
          { kind: 'direct', daemonUrl: DAEMON_URL },
          { kind: 'relay', relayUrl: 'http://plaintext.example', operator: 'self' },
          HOSTED_RELAY,
        ]),
      ).connections[0]?.carriers,
    ).eql([{ kind: 'direct', daemonUrl: DAEMON_URL }, HOSTED_RELAY]);
  });

  /**
   * A RECORD WITH A CREDENTIAL AND NOWHERE TO SEND IT IS THE FAILURE HERE.
   *
   * An empty stored array, and one whose every entry this build refuses to dial, are
   * the same thing on the way out: nothing said where the daemon is. Kept empty, the
   * pairing survives as a row that can never issue a request — so it can never learn
   * a new carrier either, and only a re-pair recovers. The direct address the pairing
   * arrived on is the one carrier the record itself proves.
   */
  it('should recover a stored carrier set that survives nothing to the paired direct address', () => {
    const damaged: unknown[][] = [
      [],
      [{ kind: 'relay', relayUrl: 'http://plaintext.example', operator: 'self' }],
      [null, 'not a carrier', { kind: 'direct' }],
    ];
    for (const carriers of damaged) {
      should(parseDaemonConnections(storedCarriers(carriers)).connections[0]?.carriers).eql([
        { kind: 'direct', daemonUrl: DAEMON_URL },
      ]);
    }
  });

  /**
   * The refresh that produced an empty set travelled a carrier that worked, so it
   * contradicts its own evidence. Written through, it would leave a reachable daemon
   * with nothing to dial and no request left that could ever say otherwise.
   */
  it('should keep a known-working cache when an authenticated refresh publishes nothing', () => {
    const store = new DaemonConnectionStore();
    let notifications = 0;
    const record = store.add(connection(FINGERPRINT, [SELF_RELAY]));
    store.subscribe(() => {
      notifications += 1;
    });
    should(store.replaceCarriers(record, [])).equal(store.get(record.daemonId));
    should(store.get(record.daemonId)?.carriers).eql([{ kind: 'direct', daemonUrl: DAEMON_URL }, SELF_RELAY]);
    should(notifications).equal(0);
  });

  it('should drop a stored carrier that is not one rather than guess at it', () => {
    for (const damaged of [null, 7, [], { kind: 'direct', daemonUrl: DAEMON_URL }, { kind: 'relay' }]) {
      should(parseDaemonConnections(stored(damaged)).connections[0]?.carriers).eql([
        { kind: 'direct', daemonUrl: DAEMON_URL },
      ]);
    }
  });

  it('should write a carrier back out so the next load can read it', async () => {
    const saved = new Map<string, string>();
    const store = new DaemonConnectionStore(
      { connections: [], selectedDaemonId: null },
      {
        repository: {
          load: async () => saved.get(CONNECTIONS_KEY) ?? null,
          save: async (key, value) => void saved.set(key, value),
        },
      },
    );
    const record = store.add(connection(FINGERPRINT));
    const direct = { kind: 'direct' as const, daemonUrl: DAEMON_URL };
    should(store.replaceCarriers(record, [direct, SELF_RELAY])?.carriers).eql([direct, SELF_RELAY]);
    // Idempotent: the same answer is not a new snapshot.
    should(store.replaceCarriers(record, [direct, SELF_RELAY])?.carriers).eql([direct, SELF_RELAY]);
    // Replacement, not merge: a withdrawn relay disappears and a new pair takes its place.
    should(store.replaceCarriers(record, [direct])?.carriers).eql([direct]);
    should(store.replaceCarriers(record, [direct, HOSTED_RELAY, SELF_RELAY])?.carriers).eql([
      direct,
      HOSTED_RELAY,
      SELF_RELAY,
    ]);
    await store.flush();
    should(parseDaemonConnections(saved.get(CONNECTIONS_KEY) ?? null).connections[0]?.carriers).eql([
      direct,
      HOSTED_RELAY,
      SELF_RELAY,
    ]);
  });

  it('should say nothing about a daemon that is not paired', () => {
    const store = new DaemonConnectionStore();
    should(store.replaceCarriers(connection(FINGERPRINT), [SELF_RELAY])).be.undefined();
  });
});

describe('the event stream on a relayed carrier', () => {
  const daemon = connection(FINGERPRINT, [HOSTED_RELAY]);

  const ticketBody = JSON.stringify({
    ticket: `fy_ticket_${'t'.repeat(43)}`,
    ttlSeconds: 30,
    expiresAt: '2026-08-03T12:00:30.000Z',
  });

  it('should refuse before it spends a ticket the daemon would have burned', async () => {
    let asked = 0;
    await should(
      daemonEventTicket(
        daemon,
        async () => {
          asked += 1;
          return new Response(ticketBody);
        },
        () => HOSTED_RELAY,
      ),
    ).be.rejectedWith(RELAY_STREAM_UNSUPPORTED);
    should(asked).equal(0);
  });

  it('should refuse a stream rather than open a socket that can never carry one', async () => {
    const transport = new DaemonEventTransport(
      daemon,
      async () => 'ticket',
      () => {
        throw new Error('no socket may be constructed');
      },
      () => HOSTED_RELAY,
    );
    await should(
      transport.stream({ url: `${DAEMON_URL}/v1/events`, token: 'x', onMessage: () => undefined }),
    ).be.rejectedWith(RELAY_STREAM_UNSUPPORTED);
  });

  it('should carry on as before when the live carrier is direct', async () => {
    const issued = await daemonEventTicket(
      daemon,
      async () => new Response(ticketBody),
      () => ({
        kind: 'direct',
        daemonUrl: DAEMON_URL,
      }),
    );
    should(issued).equal(`fy_ticket_${'t'.repeat(43)}`);
  });
});
