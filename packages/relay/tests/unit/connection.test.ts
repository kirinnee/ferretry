import { describe, it } from 'bun:test';
import {
  type ConnectionMethod,
  ConnectionMethodSchema,
  chooseConnection,
  connectionPreferenceOrder,
  connectionSocketUrl,
  describeConnectionMethod,
  parseRendezvousPath,
  SocketEndpointSchema,
} from '@ferretry/relay';
import should from 'should';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const direct: ConnectionMethod = { kind: 'direct', daemonUrl: 'https://box.tailnet.example' };
const relay: ConnectionMethod = { kind: 'relay', relayUrl: 'https://relay.example' };
const hosted: ConnectionMethod = { kind: 'relay', relayUrl: 'https://hosted.example', operator: 'hosted' };

describe('socket endpoints', () => {
  it('should accept secure schemes anywhere and insecure ones only where the published CSP allows', () => {
    should(SocketEndpointSchema.parse('https://box.example/')).equal('https://box.example');
    should(SocketEndpointSchema.parse('wss://box.example')).equal('wss://box.example');
    should(SocketEndpointSchema.parse('http://127.0.0.1:7431')).equal('http://127.0.0.1:7431');
    should(SocketEndpointSchema.parse('ws://localhost:7431')).equal('ws://localhost:7431');
    should(SocketEndpointSchema.safeParse('http://box.example').success).be.false();
    should(SocketEndpointSchema.safeParse('ftp://box.example').success).be.false();
    should(SocketEndpointSchema.safeParse('not a url').success).be.false();
    should(SocketEndpointSchema.safeParse('https://box.example/?token=x').success).be.false();
    should(SocketEndpointSchema.safeParse('https://box.example/#fragment').success).be.false();
  });

  // The endpoint that survives here is dialled by a browser running the published site, and that
  // site's `connect-src` names exactly two insecure hosts. Every host below IS loopback — the
  // protocol's own `isLoopbackHost` says so — and the browser blocks every one of them anyway, so
  // accepting one would store a carrier that can only ever fail before it makes a request.
  it('should refuse insecure loopback spellings the published CSP does not carry', () => {
    for (const spelling of ['localhost', '127.0.0.1', 'LOCALHOST']) {
      should(SocketEndpointSchema.safeParse(`http://${spelling}:7431`).success).be.true();
      should(SocketEndpointSchema.safeParse(`ws://${spelling}:7431`).success).be.true();
    }
    for (const spelling of ['127.0.0.2', '127.255.255.255', 'fy.localhost', '[::1]', '[0:0:0:0:0:0:0:1]']) {
      should(SocketEndpointSchema.safeParse(`http://${spelling}:7431`).success).be.false();
      should(SocketEndpointSchema.safeParse(`ws://${spelling}:7431`).success).be.false();
      // The scheme is the whole difference: TLS makes the same host dialable, so this narrowing
      // takes nothing away from an operator who serves one properly.
      should(SocketEndpointSchema.safeParse(`https://${spelling}:7431`).success).be.true();
      should(SocketEndpointSchema.safeParse(`wss://${spelling}:7431`).success).be.true();
    }
  });

  it('should parse each carrier shape with no relay address baked in', () => {
    should(ConnectionMethodSchema.parse(direct)).deepEqual(direct);
    should(ConnectionMethodSchema.parse(relay)).deepEqual(relay);
    should(ConnectionMethodSchema.parse(hosted)).deepEqual(hosted);
    should(ConnectionMethodSchema.safeParse({ kind: 'relay' }).success).be.false();
    should(
      ConnectionMethodSchema.safeParse({ kind: 'relay', relayUrl: 'https://relay.example', operator: 'somebody' })
        .success,
    ).be.false();
    should(ConnectionMethodSchema.safeParse({ kind: 'hosted', relayUrl: 'https://relay.example' }).success).be.false();
  });
});

describe('rendezvous addressing', () => {
  it('should spell the same path on both carriers', () => {
    should(connectionSocketUrl(direct, daemonId, 'client')).equal(
      `wss://box.tailnet.example/v1/rendezvous/${daemonId}/client`,
    );
    should(connectionSocketUrl(relay, daemonId, 'daemon')).equal(
      `wss://relay.example/v1/rendezvous/${daemonId}/daemon`,
    );
    should(connectionSocketUrl({ kind: 'relay', relayUrl: 'ws://localhost:8787' }, daemonId, 'client')).equal(
      `ws://localhost:8787/v1/rendezvous/${daemonId}/client`,
    );
  });

  it('should refuse a daemon role on a direct carrier, and an identifier that is not one', () => {
    should(connectionSocketUrl(direct, daemonId, 'daemon')).be.null();
    should(connectionSocketUrl(relay, 'fy_daemon_short', 'client')).be.null();
  });

  it('should read a route back out of a path, and refuse anything else', () => {
    should(parseRendezvousPath(`/v1/rendezvous/${daemonId}/daemon`)).deepEqual({ daemonId, role: 'daemon' });
    should(parseRendezvousPath(`/v1/rendezvous/${daemonId}/client/extra`)).be.null();
    should(parseRendezvousPath(`/v2/rendezvous/${daemonId}/client`)).be.null();
    should(parseRendezvousPath(`/v1/lobby/${daemonId}/client`)).be.null();
    should(parseRendezvousPath(`/v1/rendezvous/${daemonId}/admin`)).be.null();
    should(parseRendezvousPath('/v1/rendezvous/nonsense/client')).be.null();
  });

  it('should survive the round trip from URL to route', () => {
    const url = connectionSocketUrl(relay, daemonId, 'client');
    if (url === null) throw new Error('expected a URL');
    should(parseRendezvousPath(new URL(url).pathname)).deepEqual({ daemonId, role: 'client' });
  });
});

describe('carrier disclosure and choice', () => {
  it('should say plainly what each carrier costs', () => {
    const directly = describeConnectionMethod(direct);
    should(directly.label).equal('Direct');
    should(directly.observers.length).be.above(0);

    const relayed = describeConnectionMethod(relay);
    should(relayed.label).equal('Your own relay');
    should(relayed.observers.join(' ')).match(/cannot read a frame/u);
    should(relayed.requires.join(' ')).match(/fingerprint listed/u);

    const hostedDisclosure = describeConnectionMethod(hosted);
    should(hostedDisclosure.label).equal('Hosted relay');
    should(hostedDisclosure.observers.join(' ')).match(/cannot read frame payloads/u);
    should(hostedDisclosure.requires.join(' ')).match(/global ceilings/u);
  });

  it('should always try direct first', () => {
    should(connectionPreferenceOrder([relay, direct])).deepEqual([direct, relay]);
  });

  it('should take the first reachable carrier and name it', () => {
    const chosen = chooseConnection([{ method: direct, reachable: true }]);
    should(chosen.ok).be.true();
    if (chosen.ok) {
      should(chosen.method).deepEqual(direct);
      should(chosen.reason).equal('Connected over direct.');
      should(chosen.passedOver).deepEqual([]);
    }
  });

  it('should never degrade to a relay quietly', () => {
    const chosen = chooseConnection([
      { method: direct, reachable: false, detail: 'timed out after 3s' },
      { method: relay, reachable: true },
    ]);
    should(chosen.ok).be.true();
    if (chosen.ok) {
      should(chosen.method).deepEqual(relay);
      should(chosen.reason).equal(
        'Connected over your own relay because direct was not reachable (timed out after 3s).',
      );
      should(chosen.passedOver.length).equal(1);
    }
  });

  it('should refuse rather than invent a carrier, and still explain itself', () => {
    const nothingConfigured = chooseConnection([]);
    should(nothingConfigured.ok).be.false();
    if (!nothingConfigured.ok) should(nothingConfigured.reason).match(/No connection method is configured/u);

    const nothingWorked = chooseConnection([{ method: direct, reachable: false }]);
    should(nothingWorked.ok).be.false();
    if (!nothingWorked.ok) should(nothingWorked.reason).match(/no reason reported/u);
  });
});
