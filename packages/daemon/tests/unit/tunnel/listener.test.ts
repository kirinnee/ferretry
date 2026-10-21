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
    should(tunnelPeer(headersFrom({ 'cf-connecting-ip': '2001:db8::7' }))).equal('2001:db8::7');
    should(tunnelPeer(headersFrom({}))).equal(TUNNEL_SHARED_PEER);
    should(tunnelPeer(headersFrom({ 'cf-connecting-ip': 'x'.repeat(200) }))).equal('tunnel');
    should(tunnelPeer(headersFrom({ 'cf-connecting-ip': 'evil host' }))).equal('tunnel');
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
