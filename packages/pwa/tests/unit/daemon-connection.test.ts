import { describe, it } from 'bun:test';
import should from 'should';
import { daemonBaseUrl, daemonConnection, daemonId, sameDaemonConnection } from '../../src/lib/daemon-connection.ts';

describe('daemon connection', () => {
  it('should preserve a runtime daemon identity and normalize its URL', () => {
    // Act
    const actual = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test/',
      deviceToken: 'device-a',
    });

    // Assert
    should(actual).deepEqual({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceToken: 'device-a',
      carriers: [{ kind: 'direct', daemonUrl: 'https://a.example.test' }],
    });
  });

  it('should reject empty daemon identities and device tokens', () => {
    // Act
    const emptyIdentity = (): unknown => daemonId('  ');
    const emptyToken = (): unknown =>
      daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: '' });

    // Assert
    should(emptyIdentity).throw('daemonId must not be empty');
    should(emptyToken).throw('deviceToken must not be empty');
  });

  it('should reject malformed and unsafe daemon URLs', () => {
    // Act
    const malformed = (): unknown => daemonBaseUrl('not a URL');
    const unsupported = (): unknown => daemonBaseUrl('ws://daemon.example.test');
    const credentialed = (): unknown => daemonBaseUrl('https://token@daemon.example.test');
    const queried = (): unknown => daemonBaseUrl('https://daemon.example.test?token=secret');
    const fragmented = (): unknown => daemonBaseUrl('https://daemon.example.test#secret');
    const pathPrefixed = (): unknown => daemonBaseUrl('https://daemon.example.test/reverse-proxy');

    // Assert
    should(malformed).throw('daemon URL must be absolute');
    should(unsupported).throw('daemon URL must use http or https');
    should(credentialed).throw('daemon URL may not include credentials, a query, or a fragment');
    should(queried).throw('daemon URL may not include credentials, a query, or a fragment');
    should(fragmented).throw('daemon URL may not include credentials, a query, or a fragment');
    should(pathPrefixed).throw('daemon URL must be an origin without a path');
  });
  it('should treat a rotated grant as a different connection and an equivalent rebuild as the same one', () => {
    // Arrange
    const paired = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceToken: 'grant-1',
    });
    const rebuilt = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceToken: 'grant-1',
    });
    // A re-pair keeps the durable id and moves exactly one of the other two.
    const rotatedToken = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceToken: 'grant-2',
    });
    const movedUrl = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a2.example.test',
      deviceToken: 'grant-1',
    });
    const otherDaemon = daemonConnection({
      daemonId: 'daemon-b',
      baseUrl: 'https://a.example.test',
      deviceToken: 'grant-1',
    });
    const movedCarrier = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceToken: 'grant-1',
      carriers: [
        { kind: 'direct', daemonUrl: 'https://a.example.test' },
        { kind: 'relay', relayUrl: 'https://relay.example' },
      ],
    });

    // Assert
    should(sameDaemonConnection(paired, paired)).be.true();
    // Field equality, not object identity: a host that rebuilds this each
    // render has not re-paired, and blanking its panes would be a bug.
    should(sameDaemonConnection(paired, rebuilt)).be.true();
    // The durable id alone cannot answer the question — all three of these
    // share it, and two of them are new grants.
    should(sameDaemonConnection(paired, rotatedToken)).be.false();
    should(sameDaemonConnection(paired, movedUrl)).be.false();
    should(sameDaemonConnection(paired, otherDaemon)).be.false();
    should(sameDaemonConnection(paired, movedCarrier)).be.false();
    // Symmetric, so no caller has to remember which side is the incumbent.
    should(sameDaemonConnection(rotatedToken, paired)).be.false();
  });
});
