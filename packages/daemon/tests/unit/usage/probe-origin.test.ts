import { describe, it } from 'bun:test';
import should from 'should';
import { usageProbeUrls } from '../../../src/lib/usage/probe-origin.ts';

describe('usageProbeUrls', () => {
  it('should answer the providers’ own endpoints when nothing is set', () => {
    // Act / Assert
    should(usageProbeUrls(undefined)).be.undefined();
    should(usageProbeUrls('')).be.undefined();
    should(usageProbeUrls('   ')).be.undefined();
  });

  it('should move both reads to a loopback origin, keeping its port', () => {
    // Act
    const urls = usageProbeUrls('http://127.0.0.1:43123');

    // Assert
    should(urls).deepEqual({
      anthropic: 'http://127.0.0.1:43123/api/oauth/usage',
      codex: 'http://127.0.0.1:43123/backend-api/wham/usage',
    });
  });

  for (const origin of ['https://localhost:8443', 'http://[::1]:9000', ' http://localhost:7000/ ']) {
    it(`should accept the loopback origin ${origin.trim()}`, () => {
      // Act
      const urls = usageProbeUrls(origin);

      // Assert
      const expected = new URL(origin.trim()).origin;
      should(urls).deepEqual({
        anthropic: `${expected}/api/oauth/usage`,
        codex: `${expected}/backend-api/wham/usage`,
      });
    });
  }

  for (const [why, origin] of [
    ['another host', 'http://usage.example.com'],
    ['an address that is not loopback', 'http://10.0.0.2:8080'],
    ['a loopback-looking hostname', 'http://127.0.0.1.example.com'],
    ['a path', 'http://127.0.0.1:8080/proxy'],
    ['a query', 'http://127.0.0.1:8080/?to=elsewhere'],
    ['a fragment', 'http://127.0.0.1:8080/#x'],
    ['credentials in the URL', 'http://user:pass@127.0.0.1:8080'],
    ['a username alone', 'http://user@127.0.0.1:8080'],
    ['a scheme that is not http', 'ftp://127.0.0.1'],
    ['a file URL', 'file:///tmp/usage'],
    ['text that is not a URL', 'not a url'],
  ] as const) {
    it(`should refuse ${why} and keep the providers’ endpoints`, () => {
      // Act / Assert
      should(usageProbeUrls(origin)).be.undefined();
    });
  }
});
