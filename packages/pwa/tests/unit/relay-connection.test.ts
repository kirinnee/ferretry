/**
 * What a paired daemon's carriers are, what survives a reload, and what does not.
 *
 * Three claims are load-bearing and none of them is visible from a coverage number,
 * because each is a single condition on a single line:
 *
 *   1. Direct is ordered first, always, and a relay is offered only for a
 *      fingerprint a rendezvous can actually address.
 *   2. A relay its owner supplied survives a reload; Ferretry's hosted one does NOT,
 *      because a remembered hosted address is a browser the kill switch cannot reach.
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
import { daemonCarriers, daemonConnection, type RelayCarrier } from '../../src/lib/daemon-connection.ts';
import { DaemonEventTransport, daemonEventTicket, RELAY_STREAM_UNSUPPORTED } from '../../src/lib/event-transport.ts';

const FINGERPRINT = `fy_daemon_${'A'.repeat(43)}`;
const DAEMON_URL = 'https://studio.example';
const SELF_RELAY: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay.mine', operator: 'self' };
const HOSTED_RELAY: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay.ferretry', operator: 'hosted' };

const connection = (daemonId: string, relay?: RelayCarrier) =>
  daemonConnection({
    daemonId,
    baseUrl: DAEMON_URL,
    deviceToken: 'fy_device_x',
    ...(relay === undefined ? {} : { relay }),
  });

const stored = (relay: unknown) =>
  JSON.stringify({
    v: CONNECTIONS_VERSION,
    selectedDaemonId: FINGERPRINT,
    connections: [
      { daemonId: FINGERPRINT, baseUrl: DAEMON_URL, deviceToken: 'fy_device_x', pairedAt: 1, lastSelectedAt: 2, relay },
    ],
  });

describe('the carriers one paired daemon has', () => {
  it('should order direct first and name the relay second', () => {
    should(daemonCarriers(connection(FINGERPRINT, HOSTED_RELAY))).eql([
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
    should(daemonCarriers(connection('sha256:legacy-spelling', HOSTED_RELAY))).eql([
      { kind: 'direct', daemonUrl: DAEMON_URL },
    ]);
  });

  it('should refuse a relay address this browser may not dial', () => {
    should(() => connection(FINGERPRINT, { kind: 'relay', relayUrl: 'http://not-loopback.example' })).throw(
      /not a dialable rendezvous/u,
    );
  });
});

describe('a stored pairing registry', () => {
  it('should restore a relay its owner supplied, including one written before the operator field', () => {
    should(parseDaemonConnections(stored(SELF_RELAY)).connections[0]?.relay).eql(SELF_RELAY);
    should(parseDaemonConnections(stored({ kind: 'relay', relayUrl: 'https://relay.mine' })).connections[0]?.relay).eql(
      SELF_RELAY,
    );
  });

  it('should NOT restore Ferretry’s hosted relay, so the kill switch always reaches this browser', () => {
    should(parseDaemonConnections(stored(HOSTED_RELAY)).connections[0]?.relay).be.undefined();
  });

  it('should drop a stored carrier that is not one rather than guess at it', () => {
    for (const damaged of [null, 7, [], { kind: 'direct', daemonUrl: DAEMON_URL }, { kind: 'relay' }]) {
      should(parseDaemonConnections(stored(damaged)).connections[0]?.relay).be.undefined();
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
    should(store.attachRelay(record.daemonId, SELF_RELAY)?.relay).eql(SELF_RELAY);
    // Idempotent: the same answer is not a new snapshot.
    should(store.attachRelay(record.daemonId, SELF_RELAY)?.relay).eql(SELF_RELAY);
    // A withdrawn advertisement is a real answer, and it takes the carrier away.
    should(store.attachRelay(record.daemonId, undefined)?.relay).be.undefined();
    should(store.attachRelay(record.daemonId, HOSTED_RELAY)?.relay).eql(HOSTED_RELAY);
    await store.flush();
    should(parseDaemonConnections(saved.get(CONNECTIONS_KEY) ?? null).connections[0]?.relay).be.undefined();
  });

  it('should say nothing about a daemon that is not paired', () => {
    const store = new DaemonConnectionStore();
    should(store.attachRelay(connection(FINGERPRINT).daemonId, SELF_RELAY)).be.undefined();
  });
});

describe('the event stream on a relayed carrier', () => {
  const daemon = connection(FINGERPRINT, HOSTED_RELAY);

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
