/**
 * How a tunnel arrival is keyed: by the address Cloudflare's edge saw — or one shared bucket when it did not say.
 * The listener itself (one route, `404` for everything else, every arrival remote) is the kernel's, tested in
 * `core/kernel/tests/unit/host/carrier-listener.test.ts` and, wired to this carrier, in `runtime/compose-b.test.ts`.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { headersFrom } from '@ferretry/kernel/contract';
import { TUNNEL_PEER_HEADER, TUNNEL_SHARED_PEER, tunnelPeer } from '../../../daemon/lib/tunnel/listener.ts';
import { guarantee } from '../../support/guarantee.ts';

describe('the tunnel listener’s peer key', () => {
  it('should key a peer by CF-Connecting-IP, and share one bucket when it is absent or not an address', () => {
    should(TUNNEL_PEER_HEADER).equal('cf-connecting-ip');
    should(tunnelPeer(headersFrom({ 'CF-Connecting-IP': ' 203.0.113.9 ' }))).equal('203.0.113.9');
    should(tunnelPeer(headersFrom({ 'cf-connecting-ip': '256.1.1.1' }))).equal('tunnel');
    should(tunnelPeer(headersFrom({}))).equal(TUNNEL_SHARED_PEER);
    should(tunnelPeer(headersFrom({ 'cf-connecting-ip': 'x'.repeat(200) }))).equal('tunnel');
    should(tunnelPeer(headersFrom({ 'cf-connecting-ip': 'evil host' }))).equal('tunnel');
  });

  guarantee(['R661'], 'should key an IPv6 peer by its /64, so one subscriber is one bucket', () => {
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
});
