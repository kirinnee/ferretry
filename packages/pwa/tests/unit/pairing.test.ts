import { describe, it } from 'bun:test';
import should from 'should';
import {
  pairedDaemonConnection,
  pairingArrival,
  pairingDaemonHost,
  pairingSeedFromUrl,
} from '../../src/lib/pairing.ts';

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

describe('pairing arrival', () => {
  const link = 'https://app.example.test/pair#v1;url=https%3A%2F%2Fdaemon.example.test;code=7F3K-Q2ND;fp=daemon-fp';

  it('should read a pre-filled arrival straight out of the fragment', () => {
    // Act
    const actual = pairingArrival(link);

    // Assert
    should(actual).deepEqual({
      kind: 'seed',
      seed: { daemonUrl: 'https://daemon.example.test', daemonId: 'daemon-fp', code: '7F3K-Q2ND' },
    });
  });

  it('should treat an address that claims no pairing link as a cold open', () => {
    // Assert
    should(pairingArrival('https://app.example.test/')).deepEqual({ kind: 'none' });
    should(pairingArrival('https://app.example.test/pair#')).deepEqual({ kind: 'none' });
    should(pairingArrival('https://app.example.test/pair#palette')).deepEqual({ kind: 'none' });
    // `v10;` is a different, later version — not a v1 link with junk after it.
    should(pairingArrival('https://app.example.test/pair#v10;url=a')).deepEqual({ kind: 'none' });
    should(pairingArrival('not-a-url#v1;url=a')).deepEqual({ kind: 'none' });
  });

  it('should refuse rather than silently show a cold screen when a v1 link is damaged', () => {
    // Act
    const truncated = pairingArrival('https://app.example.test/pair#v1;url=https%3A%2F%2Fd.test;code=abc');
    const versionOnly = pairingArrival('https://app.example.test/pair#v1');

    // Assert
    should(truncated).deepEqual({ kind: 'unreadable', reason: 'pairing URL must include url, code, and fp only' });
    should(versionOnly.kind).equal('unreadable');
  });

  it('should name the daemon by the host a reader can recognise', () => {
    // Arrange
    const arrival = pairingArrival(link);

    // Act
    const actual = arrival.kind === 'seed' ? pairingDaemonHost(arrival.seed) : null;

    // Assert
    should(actual).equal('daemon.example.test');
  });
});

describe('paired daemon connection', () => {
  it('should only accept a pairing response for the fingerprint in the pairing link', () => {
    // Arrange
    const seed = pairingSeedFromUrl(
      'https://app.example.test/pair#v1;url=http%3A%2F%2F127.0.0.1%3A7431;code=a;fp=loopback',
    );

    // Act
    const actual = pairedDaemonConnection(seed, {
      daemonId: 'loopback',
      deviceToken: 'device-token',
      carriers: [],
    });
    const mismatch = (): unknown =>
      pairedDaemonConnection(seed, { daemonId: 'different', deviceToken: 'device-token', carriers: [] });

    // Assert
    should(actual).deepEqual({
      daemonId: 'loopback',
      baseUrl: 'http://127.0.0.1:7431',
      deviceToken: 'device-token',
      carriers: [{ kind: 'direct', daemonUrl: 'http://127.0.0.1:7431' }],
    });
    should(mismatch).throw('pairing response daemon ID does not match its fingerprint');
  });

  it('should drop an undialable published carrier rather than fail the whole pairing', () => {
    // Arrange
    const seed = pairingSeedFromUrl(
      'https://app.example.test/pair#v1;url=http%3A%2F%2F127.0.0.1%3A7431;code=a;fp=loopback',
    );

    // Act
    const actual = pairedDaemonConnection(
      seed,
      {
        daemonId: 'loopback',
        deviceToken: 'device-token',
        carriers: [
          // A reverse-proxy prefix, credentials and a scheme nobody dials: refused by the daemon's own
          // wire schema, and refused here too if one arrives from a daemon that never applied it.
          { kind: 'direct', url: 'https://box.example/behind/a/proxy' },
          { kind: 'direct', url: 'https://user:pw@box.example' },
          { kind: 'direct', url: 'ftp://box.example' },
          { kind: 'direct', url: 'http://127.0.0.1:7431' },
          { kind: 'relay', url: 'https://relay.example' },
        ],
      },
      'https://relay.example',
    );

    // Assert
    should(actual.carriers).deepEqual([
      { kind: 'direct', daemonUrl: 'http://127.0.0.1:7431' },
      { kind: 'relay', relayUrl: 'https://relay.example', operator: 'hosted' },
    ]);
  });

  it('should fall back to the address the pairing succeeded on when nothing published survives', () => {
    // Arrange
    const seed = pairingSeedFromUrl(
      'https://app.example.test/pair#v1;url=http%3A%2F%2F127.0.0.1%3A7431;code=a;fp=loopback',
    );

    // Act
    const actual = pairedDaemonConnection(seed, {
      daemonId: 'loopback',
      deviceToken: 'device-token',
      carriers: [{ kind: 'direct', url: 'https://box.example/behind/a/proxy' }],
    });

    // Assert
    should(actual.carriers).deepEqual([{ kind: 'direct', daemonUrl: 'http://127.0.0.1:7431' }]);
  });
});
