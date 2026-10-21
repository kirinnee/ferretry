/**
 * Whether the hosted service provisions tunnels: the origin rules, the one document, and the two answers
 * every failure folds into (`docs/relay-protocol.md` §15 "Discovery").
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  NO_TUNNEL_SERVICE,
  parseTunnelServiceAdvertisement,
  TUNNEL_SERVICE_NOT_ASKED,
  tunnelServiceAddress,
  tunnelServiceHost,
  tunnelServiceOrigin,
} from '../../../src/lib/tunnel/service.ts';

describe('the hosted tunnel service', () => {
  it('should ask the same origin the relay advertisement is read from, at the protocol’s path', () => {
    // Arrange
    const origin = tunnelServiceOrigin('https://ferretry-hosted-relay.example.workers.dev/');

    // Act / Assert — the trailing slash is dropped so the path joins as one.
    should(origin).equal('https://ferretry-hosted-relay.example.workers.dev');
    should(tunnelServiceAddress(origin as string)).equal(
      'https://ferretry-hosted-relay.example.workers.dev/v1/tunnel-service',
    );
  });

  it('should sign for the host the origin spells, port included', () => {
    should(tunnelServiceHost('https://relay.example')).equal('relay.example');
    should(tunnelServiceHost('http://127.0.0.1:8787')).equal('127.0.0.1:8787');
  });

  it('should refuse an origin it may not ask, and a socket spelling fetch cannot use', () => {
    // Plain HTTP is for loopback only, exactly as for a rendezvous.
    should(tunnelServiceOrigin('http://relay.example')).be.undefined();
    should(tunnelServiceOrigin('not a url')).be.undefined();
    // A `wss:` directory is a legal endpoint and still not an address a JSON POST can go to.
    should(tunnelServiceOrigin('wss://relay.example')).be.undefined();
    should(tunnelServiceOrigin('http://127.0.0.1:8787')).equal('http://127.0.0.1:8787');
  });

  it('should read available only from exactly a version-1 document that says so', () => {
    // Arrange
    const origin = 'https://relay.example';

    // Act / Assert
    should(parseTunnelServiceAdvertisement(origin, { version: 1, available: true })).deepEqual({
      kind: 'available',
      origin,
    });
    should(parseTunnelServiceAdvertisement(origin, { version: 1, available: false })).deepEqual({
      kind: 'unavailable',
      reason: 'the hosted tunnel service is not set up by its operator',
    });
    should(parseTunnelServiceAdvertisement(origin, { version: 2, available: true })).deepEqual({
      kind: 'unavailable',
      reason: 'the hosted service answered a document this daemon cannot read',
    });
  });

  it('should say why nothing was asked, in words a boot can print', () => {
    should(NO_TUNNEL_SERVICE).deepEqual({ kind: 'unavailable', reason: 'this build carries no hosted service to ask' });
    should(TUNNEL_SERVICE_NOT_ASKED.kind).equal('unavailable');
  });
});
