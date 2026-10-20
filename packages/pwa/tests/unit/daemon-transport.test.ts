import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { boundDaemonId, daemonBound, daemonRequest, daemonUrl } from '../../src/lib/daemon-transport.ts';

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon.example.test',
  deviceId: 'fy_dev_paired',
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

  it('should carry no credential of its own while keeping caller headers', () => {
    // Act
    const actual = daemonRequest(daemon, '/v1/sessions', { headers: { 'x-request-id': 'request-1' } });

    // Assert
    should(actual.url).equal('https://daemon.example.test/v1/sessions');
    should(new Headers(actual.init.headers).has('authorization')).be.false();
    should(new Headers(actual.init.headers).get('x-request-id')).equal('request-1');
    should(actual.init.credentials).equal('include');
    should(JSON.stringify(actual)).not.containEql('fy_dev_paired');
  });

  it('should name the daemon a request is for, beside an address another machine may share', () => {
    // Arrange — two machines paired over the relay both announce their own loopback.
    const studio = daemonConnection({
      daemonId: 'daemon-studio',
      baseUrl: 'http://127.0.0.1:7431',
      deviceId: 'fy_dev_a',
    });
    const laptop = daemonConnection({
      daemonId: 'daemon-laptop',
      baseUrl: 'http://127.0.0.1:7431',
      deviceId: 'fy_dev_b',
    });

    // Act
    const toStudio = daemonRequest(studio, '/v1/machine', { method: 'GET' });
    const toLaptop = daemonRequest(laptop, '/v1/machine');

    // Assert
    should(toStudio.url).equal(toLaptop.url);
    should(boundDaemonId(toStudio.init)).equal('daemon-studio');
    should(boundDaemonId(toLaptop.init)).equal('daemon-laptop');
    // The binding survives the spread every caller does to add a signal, and never reaches the wire.
    should(boundDaemonId({ ...toStudio.init, signal: new AbortController().signal })).equal('daemon-studio');
    should(JSON.stringify(toStudio)).not.containEql('daemon-studio');
  });

  it('should read an unbound request as bound to nothing', () => {
    // Assert
    should(boundDaemonId(undefined)).be.undefined();
    should(boundDaemonId({ method: 'GET' })).be.undefined();
    should(daemonBound(daemon).credentials).equal('include');
  });
});
