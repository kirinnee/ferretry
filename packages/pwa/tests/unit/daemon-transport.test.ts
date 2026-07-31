import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonEventUrl, daemonRequest, daemonUrl } from '../../src/lib/daemon-transport.ts';

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon.example.test/base',
  deviceToken: 'device-token',
});

describe('daemon transport', () => {
  it('should resolve requests against the paired daemon instead of the page origin', () => {
    // Act
    const actual = daemonUrl(daemon, '/v1/sessions');

    // Assert
    should(actual).equal('https://daemon.example.test/v1/sessions');
  });

  it('should reject relative daemon paths', () => {
    // Act
    const actual = (): unknown => daemonUrl(daemon, 'v1/sessions');
    const crossOrigin = (): unknown => daemonUrl(daemon, '//other.example.test/v1/sessions');
    const slashNormalizedOrigin = (): unknown => daemonUrl(daemon, ['/', '\\', 'other.example.test/path'].join(''));

    // Assert
    should(actual).throw('daemon path must be an origin-relative path');
    should(crossOrigin).throw('daemon path must be an origin-relative path');
    should(slashNormalizedOrigin).throw('daemon path must remain on the paired daemon');
  });

  it('should attach the paired device token without replacing caller headers', () => {
    // Act
    const actual = daemonRequest(daemon, '/v1/sessions', { headers: { 'x-request-id': 'request-1' } });

    // Assert
    should(actual.url).equal('https://daemon.example.test/v1/sessions');
    should(new Headers(actual.init.headers).get('authorization')).equal('Bearer device-token');
    should(new Headers(actual.init.headers).get('x-request-id')).equal('request-1');
    should(actual.init.credentials).equal('include');
  });

  it('should use a short-lived ticket rather than the device token in websocket URLs', () => {
    // Act
    const actual = daemonEventUrl(daemon, 'ticket-1');

    // Assert
    should(actual).equal('wss://daemon.example.test/v1/events?ticket=ticket-1');
    should(actual).not.containEql('device-token');
  });

  it('should preserve local loopback HTTP for development and pairing', () => {
    // Arrange
    const loopback = daemonConnection({
      daemonId: 'loopback',
      baseUrl: 'http://127.0.0.1:7337',
      deviceToken: 'loopback-token',
    });

    // Act
    const actual = daemonEventUrl(loopback, 'ticket-2');
    const missingTicket = (): unknown => daemonEventUrl(loopback, ' ');

    // Assert
    should(actual).equal('ws://127.0.0.1:7337/v1/events?ticket=ticket-2');
    should(missingTicket).throw('websocket ticket must not be empty');
  });
});
