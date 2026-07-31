import { describe, it } from 'bun:test';
import should from 'should';
import { pairedDaemonConnection, pairingSeedFromUrl } from '../../src/lib/pairing.ts';

describe('pairing seed', () => {
  it('should read runtime daemon connection values from the fragment', () => {
    // Act
    const actual = pairingSeedFromUrl(
      'https://app.example.test/pair#v1;url=https%3A%2F%2Fdaemon.example.test;code=7F3K-Q2ND;fp=daemon-fingerprint',
    );

    // Assert
    should(actual).deepEqual({
      daemonUrl: 'https://daemon.example.test',
      daemonId: 'daemon-fingerprint',
      code: '7F3K-Q2ND',
    });
  });

  it('should reject malformed, incomplete, repeated, and extended pairing fragments', () => {
    // Act
    const malformed = (): unknown => pairingSeedFromUrl('not a URL');
    const wrongVersion = (): unknown =>
      pairingSeedFromUrl('https://app.example.test/pair#v2;url=https%3A%2F%2Fa.test;code=a;fp=a');
    const incomplete = (): unknown =>
      pairingSeedFromUrl('https://app.example.test/pair#v1;url=https%3A%2F%2Fa.test;code=a');
    const repeated = (): unknown =>
      pairingSeedFromUrl('https://app.example.test/pair#v1;url=https%3A%2F%2Fa.test;code=a;code=b;fp=a');
    const extended = (): unknown =>
      pairingSeedFromUrl('https://app.example.test/pair#v1;url=https%3A%2F%2Fa.test;code=a;fp=a;extra=b');
    const invalidField = (): unknown =>
      pairingSeedFromUrl('https://app.example.test/pair#v1;url=https%3A%2F%2Fa.test;code;fp=a');

    // Assert
    should(malformed).throw('pairing URL must be absolute');
    should(wrongVersion).throw('pairing URL must use v1');
    should(incomplete).throw('pairing URL must include url, code, and fp only');
    should(repeated).throw('pairing URL repeats code');
    should(extended).throw('pairing URL must include url, code, and fp only');
    should(invalidField).throw('pairing URL contains an invalid field');
  });
});

describe('paired daemon connection', () => {
  it('should only accept a pairing response for the fingerprint in the pairing link', () => {
    // Arrange
    const seed = pairingSeedFromUrl(
      'https://app.example.test/pair#v1;url=http%3A%2F%2F127.0.0.1%3A7337;code=a;fp=loopback',
    );

    // Act
    const actual = pairedDaemonConnection(seed, { daemonId: 'loopback', deviceToken: 'device-token' });
    const mismatch = (): unknown =>
      pairedDaemonConnection(seed, { daemonId: 'different', deviceToken: 'device-token' });

    // Assert
    should(actual).deepEqual({ daemonId: 'loopback', baseUrl: 'http://127.0.0.1:7337', deviceToken: 'device-token' });
    should(mismatch).throw('pairing response daemon ID does not match its fingerprint');
  });
});
