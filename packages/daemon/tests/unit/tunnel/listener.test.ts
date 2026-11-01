/**
 * The tunnel listener's surface: one route, `404` for everything else, and every peer keyed by the
 * address Cloudflare's edge saw — or one shared bucket when it did not say.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../src/lib/api/capability.ts';
import { headersFrom } from '../../../src/lib/api/http.ts';
import type { SocketRoute } from '../../../src/lib/api/socket.ts';
import {
  TUNNEL_PEER_HEADER,
  TUNNEL_SHARED_PEER,
  tunnelListenerSurface,
  tunnelPeer,
} from '../../../src/lib/tunnel/listener.ts';
import { request } from '../api/support.ts';
import { CREDENTIALS } from '../runtime/mounts/support.ts';

const DAEMON = 'fy_daemon_tunnel';
const accepted: string[] = [];

const route: SocketRoute = {
  method: 'GET',
  path: '/v1/rendezvous/:daemonId/client',
  minimum: 'none',
  caller: 'any',
  accept: async ({ request: arrival }) => {
    accepted.push(`${arrival.path} loopback=${String(arrival.loopback)}`);
    return async () => ({ open: async () => undefined, fromClient: () => undefined, close: () => undefined });
  },
};

const surface = tunnelListenerSurface({
  route,
  credentials: CREDENTIALS,
  guard: NO_GOVERNED_ROUTES_GUARD,
  corsOrigins: ['https://ferretry.pages.dev'],
});

describe('the tunnel listener', () => {
  it('should key a peer by CF-Connecting-IP, and share one bucket when it is absent or not an address', () => {
    should(TUNNEL_PEER_HEADER).equal('cf-connecting-ip');
    should(tunnelPeer(headersFrom({ 'CF-Connecting-IP': ' 203.0.113.9 ' }))).equal('203.0.113.9');
    should(tunnelPeer(headersFrom({ 'cf-connecting-ip': '256.1.1.1' }))).equal('tunnel');
    should(tunnelPeer(headersFrom({}))).equal(TUNNEL_SHARED_PEER);
    should(tunnelPeer(headersFrom({ 'cf-connecting-ip': 'x'.repeat(200) }))).equal('tunnel');
    should(tunnelPeer(headersFrom({ 'cf-connecting-ip': 'evil host' }))).equal('tunnel');
  });

  it('should key an IPv6 peer by its /64, so one subscriber is one bucket', () => {
    // Arrange
    const peer = (value: string) => tunnelPeer(headersFrom({ 'cf-connecting-ip': value }));

    // Act / Assert — every address a single /64 customer can use lands in one bucket.
    should(peer('2001:db8:1:2::7')).equal('2001:db8:1:2::/64');
    should(peer('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).equal('2001:db8:1:2::/64');
    should(peer('2001:db8:1:3::7')).equal('2001:db8:1:3::/64');
    should(peer('::1')).equal('0:0:0:0::/64');
    should(peer('fe80::')).equal('fe80:0:0:0::/64');
    // An IPv4-mapped address is the IPv4 address it carries.
    should(peer('::ffff:203.0.113.9')).equal('203.0.113.9');
    // Anything that is not an address shares the one bucket rather than minting its own.
    for (const garbled of [
      '1::2::3',
      'gggg::1',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4:5:6:7::8',
      '::ffff:1.2.3',
      'a.b',
    ])
      should(peer(garbled)).equal(TUNNEL_SHARED_PEER);
  });

  it('should answer 404 to every request that is not the session upgrade', async () => {
    // Act
    const answers = await Promise.all(
      ['/v1/health', '/v1/carriers', `/v1/rendezvous/${DAEMON}/client`, '/'].map(
        async path => await surface.http.dispatch(request({ path })),
      ),
    );

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([404, 404, 404, 404]);
    should(JSON.parse(answers[0]?.body ?? '{}')).deepEqual({
      error: 'nothing is served at this path',
      code: 'not_found',
    });
  });

  it('should claim only GET on the session route, so another method is the same 404', async () => {
    should(surface.sockets.claims(request({ path: `/v1/rendezvous/${DAEMON}/client` }))).be.true();
    should(surface.sockets.claims(request({ method: 'POST', path: `/v1/rendezvous/${DAEMON}/client` }))).be.false();
    should(surface.sockets.claims(request({ path: '/v1/sessions/abc/terminals/1/stream' }))).be.false();
    should([...surface.corsOrigins]).deepEqual(['https://ferretry.pages.dev']);
  });

  it('should admit the session route through the shared socket boundary, as it arrived', async () => {
    // Act
    const decision = await surface.sockets.upgrade(
      request({ path: `/v1/rendezvous/${DAEMON}/client`, loopback: false }),
    );

    // Assert
    should(decision.outcome).equal('accepted');
    should(accepted).deepEqual([`/v1/rendezvous/${DAEMON}/client loopback=false`]);
  });
});
