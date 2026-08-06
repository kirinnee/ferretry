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
      'https://app.example.test/pair#v1;url=https%3A%2F%2Fdaemon.example.test;code=7F3K-Q2ND;fp=fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );

    // Assert
    should(actual).deepEqual({
      daemonUrl: 'https://daemon.example.test',
      daemonId: 'fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      code: '7F3K-Q2ND',
    });
  });

  it('should reject malformed, incomplete and repeated pairing fragments', () => {
    // Act
    const malformed = (): unknown => pairingSeedFromUrl('not a URL');
    const wrongVersion = (): unknown =>
      pairingSeedFromUrl(
        'https://app.example.test/pair#v3;url=https%3A%2F%2Fa.test;code=7F3K-Q2ND;fp=fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );
    const incomplete = (): unknown =>
      pairingSeedFromUrl('https://app.example.test/pair#v1;url=https%3A%2F%2Fa.test;code=a');
    const repeated = (): unknown =>
      pairingSeedFromUrl(
        'https://app.example.test/pair#v1;url=https%3A%2F%2Fa.test;code=7F3K-Q2ND;code=b;fp=fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );
    const invalidField = (): unknown =>
      pairingSeedFromUrl(
        'https://app.example.test/pair#v1;url=https%3A%2F%2Fa.test;code;fp=fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );

    // Assert
    should(malformed).throw('pairing URL must be absolute');
    should(wrongVersion).throw('pairing link version is not recognised');
    should(incomplete).throw('pairing link must include url, code, and fp');
    should(repeated).throw('pairing link repeats code');
    should(invalidField).throw('pairing link field is not name=value');
  });

  /*
   * A repeat and an unknown name are opposite facts and now get opposite answers.
   * `docs/relay-protocol.md` §14 requires exactly this pair: "a v2 reader keeps rejecting a
   * duplicated field name while ignoring an unrecognised one — a duplicate is a real ambiguity, an
   * unknown name is the next version arriving".
   */
  it('should ignore an unrecognised field rather than failing the whole link', () => {
    // Act
    const actual = pairingSeedFromUrl(
      'https://app.example.test/pair#v1;url=https%3A%2F%2Fa.test;code=7F3K-Q2ND;fp=fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA;extra=b',
    );

    // Assert
    should(actual).deepEqual({
      daemonUrl: 'https://a.test',
      daemonId: 'fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      code: '7F3K-Q2ND',
    });
  });

  it('should read a v2 rendezvous candidate out of the fragment', () => {
    // Act
    const actual = pairingSeedFromUrl(
      'https://app.example.test/pair#v2;url=https%3A%2F%2Fa.test;code=7F3K-Q2ND;fp=fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA;relay=wss%3A%2F%2Frelay.example.test',
    );

    // Assert
    should(actual).deepEqual({
      daemonUrl: 'https://a.test',
      daemonId: 'fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      code: '7F3K-Q2ND',
      relay: { kind: 'relay', relayUrl: 'wss://relay.example.test' },
    });
  });

  /*
   * A v1 link predates the field, so honouring `relay=` there would let anything that could edit a
   * link add a carrier the daemon never authored. It is an unknown name under v1, and unknown names
   * are ignored.
   */
  it('should ignore a relay candidate on a v1 link', () => {
    // Act
    const actual = pairingSeedFromUrl(
      'https://app.example.test/pair#v1;url=https%3A%2F%2Fa.test;code=7F3K-Q2ND;fp=fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA;relay=wss%3A%2F%2Frelay.example.test',
    );

    // Assert
    should(actual).deepEqual({
      daemonUrl: 'https://a.test',
      daemonId: 'fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      code: '7F3K-Q2ND',
    });
  });

  /*
   * §14: "a candidate that fails the rule is dropped rather than dialled". The direct address, the
   * code and the fingerprint beside it are still good, so failing the LINK would take a working
   * direct pairing away from somebody standing next to their own machine.
   */
  it('should drop an insecure or unreadable relay candidate and keep the rest of the link', () => {
    // Act
    const insecure = pairingSeedFromUrl(
      'https://app.example.test/pair#v2;url=https%3A%2F%2Fa.test;code=7F3K-Q2ND;fp=fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA;relay=ws%3A%2F%2Frelay.example.test',
    );
    const unreadable = pairingSeedFromUrl(
      'https://app.example.test/pair#v2;url=https%3A%2F%2Fa.test;code=7F3K-Q2ND;fp=fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA;relay=not-a-url',
    );

    // Assert
    should(insecure).deepEqual({
      daemonUrl: 'https://a.test',
      daemonId: 'fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      code: '7F3K-Q2ND',
    });
    should(unreadable).deepEqual({
      daemonUrl: 'https://a.test',
      daemonId: 'fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      code: '7F3K-Q2ND',
    });
  });
});

describe('pairing arrival', () => {
  const link =
    'https://app.example.test/pair#v1;url=https%3A%2F%2Fdaemon.example.test;code=7F3K-Q2ND;fp=fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it('should read a pre-filled arrival straight out of the fragment', () => {
    // Act
    const actual = pairingArrival(link);

    // Assert
    should(actual).deepEqual({
      kind: 'seed',
      seed: {
        daemonUrl: 'https://daemon.example.test',
        daemonId: 'fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        code: '7F3K-Q2ND',
      },
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

  it('should refuse rather than silently show a cold screen when a link is damaged', () => {
    // Act
    const truncated = pairingArrival('https://app.example.test/pair#v1;url=https%3A%2F%2Fd.test;code=abc');
    const versionOnly = pairingArrival('https://app.example.test/pair#v1');

    // Assert
    should(truncated).deepEqual({ kind: 'unreadable', reason: 'pairing link must include url, code, and fp' });
    should(versionOnly.kind).equal('unreadable');
  });

  /*
   * The regex gating this function and the parser's version list must agree, and the failure when
   * they do not is SILENT: a version the regex rejects never reaches the parser, so the screen shows
   * the ordinary cold "Connect a daemon" state and a reader who just scanned a QR is told nothing at
   * all. That is strictly worse than the parser's throw. This is the test that keeps the two in step.
   */
  it('should read a v2 link as an arrival rather than as a cold open', () => {
    // Act
    const actual = pairingArrival(
      'https://app.example.test/pair#v2;url=https%3A%2F%2Fd.test;code=7F3K-Q2ND;fp=fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA;relay=wss%3A%2F%2Fr.test',
    );
    const damagedV2 = pairingArrival('https://app.example.test/pair#v2;url=https%3A%2F%2Fd.test');

    // Assert
    should(actual).deepEqual({
      kind: 'seed',
      seed: {
        daemonUrl: 'https://d.test',
        daemonId: 'fy_daemon_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        code: '7F3K-Q2ND',
        relay: { kind: 'relay', relayUrl: 'wss://r.test' },
      },
    });
    should(damagedV2.kind).equal('unreadable');
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
      'https://app.example.test/pair#v1;url=http%3A%2F%2F127.0.0.1%3A7431;code=7F3K-Q2ND;fp=fy_daemon_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    );

    // Act
    const actual = pairedDaemonConnection(seed, {
      daemonId: 'fy_daemon_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      deviceToken: 'device-token',
      carriers: [],
    });
    const mismatch = (): unknown =>
      pairedDaemonConnection(seed, {
        daemonId: 'fy_daemon_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        deviceToken: 'device-token',
        carriers: [],
      });

    // Assert
    should(actual).deepEqual({
      daemonId: 'fy_daemon_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      baseUrl: 'http://127.0.0.1:7431',
      deviceToken: 'device-token',
      carriers: [{ kind: 'direct', daemonUrl: 'http://127.0.0.1:7431' }],
    });
    should(mismatch).throw('pairing response daemon ID does not match its fingerprint');
  });

  it('should drop an undialable published carrier rather than fail the whole pairing', () => {
    // Arrange
    const seed = pairingSeedFromUrl(
      'https://app.example.test/pair#v1;url=http%3A%2F%2F127.0.0.1%3A7431;code=7F3K-Q2ND;fp=fy_daemon_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    );

    // Act
    const actual = pairedDaemonConnection(
      seed,
      {
        daemonId: 'fy_daemon_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
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
      'https://app.example.test/pair#v1;url=http%3A%2F%2F127.0.0.1%3A7431;code=7F3K-Q2ND;fp=fy_daemon_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    );

    // Act
    const actual = pairedDaemonConnection(seed, {
      daemonId: 'fy_daemon_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      deviceToken: 'device-token',
      carriers: [{ kind: 'direct', url: 'https://box.example/behind/a/proxy' }],
    });

    // Assert
    should(actual.carriers).deepEqual([{ kind: 'direct', daemonUrl: 'http://127.0.0.1:7431' }]);
  });
});

describe('a pairing that crossed a rendezvous', () => {
  const seed = pairingSeedFromUrl(
    'https://app.example.test/pair#v2;url=http%3A%2F%2F127.0.0.1%3A7431;code=7F3K-Q2ND;fp=fy_daemon_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB;relay=wss%3A%2F%2Frelay.example',
  );
  const crossed = { kind: 'relay' as const, relayUrl: 'wss://relay.example' };
  const response = (carriers: readonly { kind: 'direct' | 'relay'; url: string }[]) => ({
    daemonId: 'fy_daemon_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    deviceToken: 'device-token',
    carriers,
  });

  /*
   * §14: "The client refuses a relayed pairing whose published set does not name the rendezvous the
   * exchange itself crossed." Without it this function faces a choice with no good answer — write
   * down an address the daemon did not publish, or discard the only address known to work — and the
   * protocol removes the choice by making the disagreement fatal. The cost is stated: the daemon has
   * already minted the grant, so the operator sees a device the device itself discarded.
   */
  it('should refuse when the published set does not name the rendezvous it crossed', () => {
    const mismatch = (): unknown =>
      pairedDaemonConnection(seed, response([{ kind: 'relay', url: 'wss://somewhere.else' }]), undefined, crossed);
    const empty = (): unknown => pairedDaemonConnection(seed, response([]), undefined, crossed);

    should(mismatch).throw(/paired over a rendezvous it does not publish/u);
    // An empty set cannot name it either — and on a relayed pairing the direct fallback would be the
    // one address this browser has just proved it cannot reach.
    should(empty).throw(/paired over a rendezvous it does not publish/u);
  });

  /*
   * Compared by ADDRESS alone, deliberately. A candidate is built from a fragment or from the
   * discovery advertisement before the daemon has said anything, so its `operator` is absent or this
   * browser's own guess, while `publishedConnectionMethods` always stamps `'hosted'` or `'self'`.
   * A whole-carrier comparison would refuse every relayed pairing that ever succeeded, over a label.
   */
  it('should accept a published set that names the rendezvous under a different operator label', () => {
    const connection = pairedDaemonConnection(
      seed,
      response([{ kind: 'relay', url: 'wss://relay.example' }]),
      // No hosted address discovered, so the daemon's own relay is labelled `self` while the
      // candidate carried no label at all.
      undefined,
      crossed,
    );
    should(connection.carriers).containEql({ kind: 'relay', relayUrl: 'wss://relay.example', operator: 'self' });
  });

  /** The direct path is unaffected: it never crossed a rendezvous, so there is nothing to check. */
  it('should leave a direct pairing alone', () => {
    const connection = pairedDaemonConnection(seed, response([]));
    should(connection.carriers).eql([{ kind: 'direct', daemonUrl: 'http://127.0.0.1:7431' }]);
  });
});
