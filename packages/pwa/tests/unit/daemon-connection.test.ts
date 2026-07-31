import { describe, it } from 'bun:test';
import should from 'should';
import { daemonBaseUrl, daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';

describe('daemon connection', () => {
  it('should preserve a runtime daemon identity and normalize its URL', () => {
    // Act
    const actual = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test/',
      deviceToken: 'device-a',
    });

    // Assert
    should(actual).deepEqual({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'device-a' });
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
});
