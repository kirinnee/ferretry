import { describe, it } from 'bun:test';
import {
  type ConnectionMethod,
  ConnectionMethodSchema,
  carrierProbe,
  carrierWalkAdvances,
  chooseConnection,
  connectionPreferenceOrder,
  connectionSocketUrl,
  describeConnectionMethod,
  describeSkip,
  parseRendezvousPath,
  publishedConnectionMethods,
  SocketEndpointSchema,
} from '@ferretry/relay';
import should from 'should';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const direct: ConnectionMethod = { kind: 'direct', daemonUrl: 'https://box.tailnet.example' };
const relay: ConnectionMethod = { kind: 'relay', relayUrl: 'https://relay.example' };
const hosted: ConnectionMethod = { kind: 'relay', relayUrl: 'https://hosted.example', operator: 'hosted' };
const secureDirect: ConnectionMethod = { kind: 'direct', daemonUrl: 'https://box.example' };
const tunnel: ConnectionMethod = { kind: 'tunnel', tunnelUrl: 'https://k3x9.tunnels.example.com' };
const webrtc: ConnectionMethod = { kind: 'webrtc' };

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

  it('should hold a tunnel to a bare https origin, and give WebRTC no address at all', () => {
    should(ConnectionMethodSchema.parse({ kind: 'tunnel', tunnelUrl: 'https://k3x9.tunnels.example.com/' })).deepEqual(
      tunnel,
    );
    should(
      ConnectionMethodSchema.safeParse({ kind: 'tunnel', tunnelUrl: 'http://k3x9.example.com' }).success,
    ).be.false();
    should(ConnectionMethodSchema.safeParse({ kind: 'tunnel', tunnelUrl: 'https://localhost' }).success).be.false();
    should(
      ConnectionMethodSchema.safeParse({ kind: 'tunnel', tunnelUrl: 'https://k3x9.example.com/path' }).success,
    ).be.false();
    should(ConnectionMethodSchema.parse(webrtc)).deepEqual(webrtc);
    should(ConnectionMethodSchema.safeParse({ kind: 'webrtc', url: 'https://x.example' }).success).be.false();
  });

  it('should hold a direct carrier to the daemon origin rule, not the rendezvous one', () => {
    // A daemon on a private network address commonly serves plain HTTP, and it is the operator's own
    // machine — refusing it here would reject the most ordinary direct carrier there is.
    should(ConnectionMethodSchema.parse({ kind: 'direct', daemonUrl: 'http://box.lan:7431' })).deepEqual({
      kind: 'direct',
      daemonUrl: 'http://box.lan:7431',
    });
    should(ConnectionMethodSchema.parse({ kind: 'direct', daemonUrl: 'https://box.example/' })).deepEqual(secureDirect);
    should(
      ConnectionMethodSchema.safeParse({ kind: 'direct', daemonUrl: 'https://box.example/proxied' }).success,
    ).be.false();
    should(
      ConnectionMethodSchema.safeParse({ kind: 'direct', daemonUrl: 'https://user:pw@box.example' }).success,
    ).be.false();
    should(ConnectionMethodSchema.safeParse({ kind: 'direct', daemonUrl: 'ftp://box.example' }).success).be.false();
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

  it('should dial a tunnel exactly like a direct address, as the client and never as the daemon', () => {
    should(connectionSocketUrl(tunnel, daemonId, 'client')).equal(
      `wss://k3x9.tunnels.example.com/v1/rendezvous/${daemonId}/client`,
    );
    should(connectionSocketUrl(tunnel, daemonId, 'daemon')).be.null();
  });

  it('should give WebRTC no socket address for either role', () => {
    should(connectionSocketUrl(webrtc, daemonId, 'client')).be.null();
    should(connectionSocketUrl(webrtc, daemonId, 'daemon')).be.null();
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

    // §15 "What a tunnel operator can see, honestly", carrier by carrier.
    const tunnelled = describeConnectionMethod(tunnel);
    should(tunnelled.label).equal('Cloudflare tunnel');
    should(tunnelled.noun).equal('Cloudflare tunnel');
    should(tunnelled.observers.join(' ')).match(/Ferretry, which provisioned the tunnel, and Cloudflare/u);
    should(tunnelled.observers.join(' ')).match(/cannot read, alter or insert/u);
    should(tunnelled.observers.join(' ')).match(/stolen connector token/u);
    should(tunnelled.requires.join(' ')).match(/set up by its operator/u);

    const peer = describeConnectionMethod(webrtc);
    should(peer.label).equal('WebRTC');
    should(peer.observers.join(' ')).match(/STUN server/u);
    should(peer.summary).match(/only introduces the two ends/u);
  });

  it('should try direct, then WebRTC, then a tunnel, then a relay, keeping the order within a kind', () => {
    should(connectionPreferenceOrder([relay, direct])).deepEqual([direct, relay]);
    should(connectionPreferenceOrder([hosted, tunnel, relay, webrtc, direct, secureDirect])).deepEqual([
      direct,
      secureDirect,
      webrtc,
      tunnel,
      hosted,
      relay,
    ]);
  });

  it('should turn a published set into direct-first methods without reordering within a kind', () => {
    should(
      publishedConnectionMethods(
        [
          { kind: 'relay', url: 'https://first-relay.example' },
          { kind: 'direct', url: 'https://first-direct.example' },
          { kind: 'relay', url: 'https://hosted.example' },
          { kind: 'direct', url: 'https://second-direct.example' },
        ],
        'https://hosted.example',
      ),
    ).deepEqual([
      { kind: 'direct', daemonUrl: 'https://first-direct.example' },
      { kind: 'direct', daemonUrl: 'https://second-direct.example' },
      { kind: 'relay', relayUrl: 'https://first-relay.example', operator: 'self' },
      { kind: 'relay', relayUrl: 'https://hosted.example', operator: 'hosted' },
    ]);
    should(
      publishedConnectionMethods([
        { kind: 'relay', url: 'http://not-loopback.example' } as never,
        { kind: 'direct', url: 'http://box.lan:7431' },
      ]),
    ).deepEqual([{ kind: 'direct', daemonUrl: 'http://box.lan:7431' }]);
    should(
      publishedConnectionMethods([
        { kind: 'tunnel', url: 'https://abc.tunnels.example.com' },
        { kind: 'direct', url: 'http://box.lan:7431' },
      ]),
    ).deepEqual([
      { kind: 'direct', daemonUrl: 'http://box.lan:7431' },
      { kind: 'tunnel', tunnelUrl: 'https://abc.tunnels.example.com' },
    ]);
    // A tunnel held to the wrong rule on the way in is dropped like any other undialable member.
    should(publishedConnectionMethods([{ kind: 'tunnel', url: 'http://abc.tunnels.example.com' } as never])).deepEqual(
      [],
    );
  });

  it('should drop one undialable published carrier of either kind and keep the rest', () => {
    // Every shape the daemon's own wire schema refuses, arriving anyway — one bad member must not
    // cost a device the carriers it could have used, on a pairing or on a refresh.
    should(
      publishedConnectionMethods(
        [
          { kind: 'direct', url: 'https://box.example/behind/a/proxy' } as never,
          { kind: 'direct', url: 'https://user:pw@box.example' } as never,
          { kind: 'direct', url: 'ftp://box.example' } as never,
          { kind: 'direct', url: 'not a url' } as never,
          { kind: 'direct', url: 'http://box.lan:7431/' },
          { kind: 'relay', url: 'http://not-loopback.example' } as never,
          { kind: 'relay', url: 'https://hosted.example' },
        ],
        'https://hosted.example',
      ),
    ).deepEqual([
      { kind: 'direct', daemonUrl: 'http://box.lan:7431' },
      { kind: 'relay', relayUrl: 'https://hosted.example', operator: 'hosted' },
    ]);
    should(publishedConnectionMethods([{ kind: 'direct', url: 'https://box.example/proxied' } as never])).deepEqual([]);
  });

  it('should advance only on transport failure, never on an HTTP answer including 503', () => {
    const failed = { kind: 'transport-failure' as const, detail: 'TLS refused' };
    const answered = { kind: 'answered' as const, status: 503 };
    should(carrierWalkAdvances(failed)).be.true();
    should(carrierWalkAdvances(answered)).be.false();
    should(carrierProbe(relay, failed)).deepEqual({ method: relay, reachable: false, detail: 'TLS refused' });
    should(carrierProbe(relay, answered)).deepEqual({ method: relay, reachable: true });
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

  it('should say a carrier passed over without being tried differently from one that did not answer', () => {
    const chosen = chooseConnection([
      { method: webrtc, reachable: false, detail: 'WebRTC isn’t available in this build yet', untried: true },
      { method: tunnel, reachable: false, detail: 'timed out' },
      { method: hosted, reachable: true },
    ]);
    if (!chosen.ok) throw new Error('expected the hosted relay to carry');
    should(chosen.reason).equal(
      'Connected over hosted relay because WebRTC was not tried (WebRTC isn’t available in this build yet); Cloudflare tunnel was not reachable (timed out).',
    );
    should(chosen.passedOver[0]).deepEqual({
      method: webrtc,
      detail: 'WebRTC isn’t available in this build yet',
      untried: true,
    });
    should(chosen.passedOver[1]).deepEqual({ method: tunnel, detail: 'timed out' });
    should(describeSkip({ method: direct, detail: 'refused' })).equal('direct was not reachable (refused)');
  });

  it('should say a carrier that connected and then lost its session was reached, not unreachable', () => {
    // The owner's screen read "Cloudflare tunnel was not reachable" over a session that had connected
    // and then failed; the tunnel had carried every frame it was given.
    const lost = { kind: 'transport-failure' as const, detail: 'the session ended (4400)', connected: true as const };
    should(carrierWalkAdvances(lost)).be.true();
    const probe = carrierProbe(tunnel, lost);
    should(probe).deepEqual({ method: tunnel, reachable: false, detail: 'the session ended (4400)', connected: true });
    const chosen = chooseConnection([probe]);
    if (chosen.ok) throw new Error('expected nothing to carry');
    should(chosen.passedOver[0]).deepEqual({ method: tunnel, detail: 'the session ended (4400)', connected: true });
    should(chosen.reason).equal(
      'No configured connection worked: Cloudflare tunnel connected, but the session on it failed (the session ended (4400)).',
    );
  });
});
