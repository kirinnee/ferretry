import { describe, it } from 'bun:test';
import {
  appOriginChoice,
  DaemonIdSchema,
  formatPairingFragment,
  HOSTED_APP_ORIGIN,
  invitationRedeemableByAnotherDevice,
  PAIRING_CODE_MAX_ATTEMPTS,
  PAIRING_CODE_TTL_SECONDS,
  PAIRING_DEVICE_NAME_MAX_LENGTH,
  PAIRING_FRAGMENT_PATTERN,
  PairedDeviceIdSchema,
  PairingCodeMintRequestSchema,
  PairingCodeMintResponseSchema,
  PairingCodeStatusResponseSchema,
  type PairingLinkSeed,
  PairingRequestSchema,
  PairingResponseSchema,
  pairingLinkUrl,
  pairingMintOutcome,
  PairedDeviceSchema,
  PairingDeviceNameSchema,
  parsePairingFragment,
} from '../../../contract/index.ts';
import should from 'should';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const deviceId = `fy_device_id_${'b'.repeat(22)}`;
const pairingId = `fy_pair_${'c'.repeat(22)}`;

const DAEMON_URL = 'https://workstation.example.test';
const PAIR_APP = 'https://ferretry.pages.dev/pair';
const RELAY_URL = 'wss://relay.example';
const FRAGMENT = `#v1;url=${encodeURIComponent(DAEMON_URL)};code=7F3K-Q2ND;fp=${daemonId}`;

/** The code half of every mint, which both shapes carry unchanged. */
const minted = {
  pairingId,
  code: '7F3K-Q2ND',
  ttlSeconds: 120,
  expiresAt: '2026-08-03T12:02:00.000Z',
  daemonId,
  daemonName: 'workstation',
  grants: 'full',
} as const;

/** A mint that hands out a link, and therefore says who can redeem it. */
const invitation = (overrides: Record<string, unknown> = {}) => ({
  ...minted,
  daemonUrl: DAEMON_URL,
  pairUrl: `${PAIR_APP}${FRAGMENT}`,
  reach: 'any-device',
  ...overrides,
});

/** A mint with no link, and therefore a reason. */
const refusal = (overrides: Record<string, unknown> = {}) => ({ ...minted, refusal: 'wildcard-bind', ...overrides });

describe('pairing protocol', () => {
  it('should publish the security limits consumers must agree on', () => {
    should(PAIRING_CODE_TTL_SECONDS).equal(120);
    should(PAIRING_CODE_MAX_ATTEMPTS).equal(5);
    should(PAIRING_DEVICE_NAME_MAX_LENGTH).equal(100);
  });

  it('should validate and normalize a pairing exchange request', () => {
    should(PairingRequestSchema.parse({ code: '7F3K-Q2ND', deviceName: '  Ernest phone  ' })).deepEqual({
      code: '7F3K-Q2ND',
      deviceName: 'Ernest phone',
    });
    should(PairingRequestSchema.parse({ code: '  7f3k q2nd ', deviceName: 'phone' }).code).equal('7F3K-Q2ND');
    should(PairingRequestSchema.parse({ code: '7f3kq2nd', deviceName: 'phone' }).code).equal('7F3K-Q2ND');
  });

  it('should refuse malformed codes and unbounded or extra input', () => {
    should(PairingRequestSchema.safeParse({ code: '7F3KQ2N', deviceName: 'phone' }).success).be.false();
    should(PairingRequestSchema.safeParse({ code: '7F3K-Q2N0', deviceName: 'phone' }).success).be.false();
    should(PairingRequestSchema.safeParse({ code: '7F3K-Q2NU', deviceName: 'phone' }).success).be.false();
    should(PairingRequestSchema.safeParse({ code: '7F3K-Q2ND', deviceName: '' }).success).be.false();
    should(
      PairingRequestSchema.safeParse({
        code: '7F3K-Q2ND',
        deviceName: 'x'.repeat(PAIRING_DEVICE_NAME_MAX_LENGTH + 1),
      }).success,
    ).be.false();
    should(PairingRequestSchema.safeParse({ code: '7F3K-Q2ND', deviceName: 'phone', admin: true }).success).be.false();
  });

  it('P128 should reject terminal and bidi injection while preserving bounded international names', () => {
    for (const deviceName of ['phone\x1b[31m', 'phone\rreplacement', 'phone\u202Ename', 'phone\u200B']) {
      should(PairingRequestSchema.safeParse({ code: '7F3K-Q2ND', deviceName }).success).be.false();
    }
    const boundary = '界'.repeat(PAIRING_DEVICE_NAME_MAX_LENGTH);
    should(PairingRequestSchema.parse({ code: '7F3K-Q2ND', deviceName: boundary }).deviceName).equal(boundary);
  });

  it('should validate the complete successful response and typed credentials', () => {
    const response = {
      deviceId,
      idleExpiryDays: 30,
      daemonId,
      daemonName: 'workstation',
      capabilities: ['daemon-api'],
      carriers: [
        { kind: 'direct' as const, url: 'https://daemon.example' },
        { kind: 'relay' as const, url: 'wss://relay.example' },
      ],
    };

    should(PairingResponseSchema.parse(response)).deepEqual(response);
    // Every key is required: a redemption answer with no carrier set is refused, never read as an empty one.
    should(PairingResponseSchema.safeParse({ ...response, carriers: undefined }).success).be.false();
    should(
      PairingResponseSchema.safeParse({
        ...response,
        carriers: [{ kind: 'relay', url: 'http://relay.example' }],
      }).success,
    ).be.false();
    // A direct address the reading device would refuse is refused on the wire, not after the QR.
    should(
      PairingResponseSchema.safeParse({
        ...response,
        carriers: [{ kind: 'direct', url: 'https://daemon.example/behind/a/proxy' }],
      }).success,
    ).be.false();
    should(PairingResponseSchema.safeParse({ ...response, carriers: [], surprise: true }).success).be.false();
    should(PairedDeviceIdSchema.parse(deviceId)).equal(deviceId);
    should(DaemonIdSchema.parse(daemonId)).equal(daemonId);
    should(PairedDeviceIdSchema.safeParse(`fy_device_${'b'.repeat(43)}`).success).be.false();
    should(
      PairingResponseSchema.safeParse({ ...response, deviceToken: `fy_device_${'b'.repeat(43)}` }).success,
    ).be.false();
    should(DaemonIdSchema.safeParse('fingerprint').success).be.false();
    should(PairingResponseSchema.safeParse({ ...response, daemonName: 'workstation\u202E' }).success).be.false();
  });

  it('P15 should validate the bodyless local mint contract and its expiry metadata', () => {
    should(PairingCodeMintRequestSchema.parse({})).deepEqual({});
    should(PairingCodeMintRequestSchema.safeParse({ deviceName: 'phone' }).success).be.false();
    should(PairingCodeMintResponseSchema.parse(invitation())).deepEqual(invitation());
    // A link may not disagree with the daemon it names: a query string, a fragment carrying anything
    // else, and a fingerprint that is not this daemon's are each refused.
    should(
      PairingCodeMintResponseSchema.safeParse(invitation({ pairUrl: `${PAIR_APP}?code=7F3K-Q2ND` })).success,
    ).be.false();
    should(
      PairingCodeMintResponseSchema.safeParse(invitation({ pairUrl: `${PAIR_APP}?hint=7F3K%2DQ2ND${FRAGMENT}` }))
        .success,
    ).be.false();
    should(
      PairingCodeMintResponseSchema.safeParse(
        invitation({ pairUrl: `${PAIR_APP}${FRAGMENT.replace(/fp=.*$/u, `fp=fy_daemon_${'z'.repeat(43)}`)}` }),
      ).success,
    ).be.false();
  });

  it('P68 should never yield a link that does not say who can redeem it, in either direction', () => {
    // THE INVARIANT THIS RESPONSE GAINED. A link with no audience is what let a QR of a loopback
    // address reach a phone; an audience with no link would be a claim about nothing. Neither is a
    // value of this type, so the halves cannot travel apart — a link that arrives without an
    // audience is refused.
    const { reach, ...noReach } = invitation();
    should(reach).equal('any-device');
    should(PairingCodeMintResponseSchema.safeParse(noReach).success).be.false();
    should(PairingCodeMintResponseSchema.safeParse({ ...invitation(), refusal: 'wildcard-bind' }).success).be.false();
    const { pairUrl, ...noLink } = invitation();
    should(PairingCodeMintResponseSchema.safeParse(noLink).success).be.false();
    should(PairingCodeMintResponseSchema.safeParse({ ...refusal(), pairUrl }).success).be.false();
    should(PairingCodeMintResponseSchema.safeParse({ ...refusal(), reach: 'any-device' }).success).be.false();
  });

  it('P72 should carry a code with no link, so a daemon with no address still mints one', () => {
    // A wildcard-bound daemon serves normally and has nothing to hand out. Refusing the MINT would
    // break every default single-machine install; refusing the LINK and naming the reason does not.
    should(PairingCodeMintResponseSchema.parse(refusal())).deepEqual(refusal());
    // A reason is required. "No link, no explanation" is the dead end the whole change removes.
    const { refusal: reason, ...silent } = refusal();
    should(PairingCodeMintResponseSchema.safeParse(silent).success).be.false();
    should(PairingCodeMintResponseSchema.parse({ ...refusal(), refusal: 'loopback-bind' })).containDeep({
      refusal: 'loopback-bind',
    });
  });

  it('P71 should narrow one mint to one outcome, so no surface decides for itself', () => {
    // ONE NARROWING FOR BOTH SURFACES. `fy pair` and the browser panel each deciding whether a link is
    // drawable is how they came to disagree about the same response.
    should(pairingMintOutcome(PairingCodeMintResponseSchema.parse(invitation()))).deepEqual({
      kind: 'invitation',
      daemonUrl: DAEMON_URL,
      pairUrl: `${PAIR_APP}${FRAGMENT}`,
      reach: 'any-device',
    });
    should(pairingMintOutcome(PairingCodeMintResponseSchema.parse(refusal()))).deepEqual({
      kind: 'refusal',
      refusal: 'wildcard-bind',
    });
  });

  it('P74 should write the one fragment form from one codec, byte-identical to every shipped link', () => {
    const seed: PairingLinkSeed = { daemonUrl: DAEMON_URL, code: '7F3K-Q2ND', daemonId };
    should(`#${formatPairingFragment(seed)}`).equal(FRAGMENT);
    should(pairingLinkUrl(PAIR_APP, seed)).equal(`${PAIR_APP}${FRAGMENT}`);
    // The writer re-proves the code, so a mint composes the same spelling the schema demands back.
    should(formatPairingFragment({ ...seed, code: ' 7f3k q2nd ' })).containEql('code=7F3K-Q2ND');
  });

  it('R220 should never write a rendezvous into a fragment, whatever a caller passes beside the seed', () => {
    // THE LOAD-BEARING ASSERTION OF THE HOSTED-ONLY NARROWING. A rendezvous reaches the mint response
    // as a host-facing disclosure and must never reach the QR: the scanning device finds the hosted
    // relay in its own build's advertisement, and a link that named one would be the deferred general
    // case shipped by accident. Extra keys are spelled through a cast because the type already
    // forbids them — this pins the WRITER's behaviour, not the type's.
    const seed = { daemonUrl: DAEMON_URL, code: '7F3K-Q2ND', daemonId } as const;
    const withExtras = { ...seed, relayCandidate: RELAY_URL, relay: RELAY_URL } as PairingLinkSeed;
    should(formatPairingFragment(withExtras)).equal(FRAGMENT.slice(1));
    should(formatPairingFragment(withExtras)).not.containEql('relay');
    should(pairingLinkUrl(PAIR_APP, withExtras)).equal(`${PAIR_APP}${FRAGMENT}`);
  });

  it('should refuse to write a link from values a reader would refuse', () => {
    const seed = { daemonUrl: DAEMON_URL, code: '7F3K-Q2ND', daemonId } as const;
    should(() => formatPairingFragment({ ...seed, code: 'BAD' })).throw();
    should(() => formatPairingFragment({ ...seed, daemonId: 'fingerprint' })).throw();
  });

  it('should read the fragment back, with and without the leading hash', () => {
    const seed = { daemonUrl: DAEMON_URL, code: '7F3K-Q2ND', daemonId } as const;
    should(parsePairingFragment(FRAGMENT)).deepEqual(seed);
    should(parsePairingFragment(FRAGMENT.slice(1))).deepEqual(seed);
    // The code arrives however a person typed it and leaves normalised.
    should(parsePairingFragment(`v1;url=${encodeURIComponent(DAEMON_URL)};code=7f3kq2nd;fp=${daemonId}`).code).equal(
      '7F3K-Q2ND',
    );
  });

  it('P75 should ignore an unrecognised field and refuse a repeated one', () => {
    // An unknown name is the next version arriving; a duplicate is a real ambiguity.
    should(parsePairingFragment(`${FRAGMENT};hint=later`)).deepEqual({
      daemonUrl: DAEMON_URL,
      code: '7F3K-Q2ND',
      daemonId,
    });
    should(() => parsePairingFragment(`${FRAGMENT};code=7F3K-Q2ND`)).throw(/repeats code/u);
    should(() => parsePairingFragment(`${FRAGMENT};hint=a;hint=b`)).throw(/repeats hint/u);
  });

  it('P75 should ignore a relay field on a link rather than ever honouring one', () => {
    // `relay` is an unrecognised name and stays one. No writer emits it, and a reader that dialled it
    // would let whoever composed a URL choose where this browser opens a pre-auth socket. The
    // withdrawn `v2` form is what made this case worth its own test: the field name now has no
    // meaning at any version, valid-looking or not.
    for (const relay of [RELAY_URL, 'ws://relay.example', 'not a url', '']) {
      const fragment = `${FRAGMENT};relay=${encodeURIComponent(relay)}`;
      should(parsePairingFragment(fragment)).deepEqual({ daemonUrl: DAEMON_URL, code: '7F3K-Q2ND', daemonId });
    }
    // And the version that would have carried it is not readable at all, so a stale emitter fails
    // loudly here rather than having its rendezvous quietly honoured.
    should(() => parsePairingFragment(`#v2;url=${encodeURIComponent(DAEMON_URL)};code=7F3K-Q2ND;fp=${daemonId}`)).throw(
      /version/u,
    );
  });

  it('P75 should name the exact reason a fragment cannot be a pairing link', () => {
    should(() => parsePairingFragment(`#v3;url=a;code=b;fp=c`)).throw(/version/u);
    should(() => parsePairingFragment('')).throw(/version/u);
    should(() => parsePairingFragment('#v1')).throw(/must include url, code, and fp/u);
    should(() => parsePairingFragment(`#v1;url=${encodeURIComponent(DAEMON_URL)};code=7F3K-Q2ND`)).throw(
      /must include url, code, and fp/u,
    );
    should(() => parsePairingFragment(`${FRAGMENT};noequals`)).throw(/name=value/u);
    should(() => parsePairingFragment(`${FRAGMENT};=orphan`)).throw(/name=value/u);
    should(() => parsePairingFragment(`${FRAGMENT};hint=%ZZ`)).throw(/not decodable/u);
    should(() => parsePairingFragment(`#v1;url=not%20a%20url;code=7F3K-Q2ND;fp=${daemonId}`)).throw(/daemon address/u);
    should(() => parsePairingFragment(`#v1;url=${encodeURIComponent(DAEMON_URL)};code=BAD;fp=${daemonId}`)).throw(
      /invalid code/u,
    );
    should(() => parsePairingFragment(`#v1;url=${encodeURIComponent(DAEMON_URL)};code=7F3K-Q2ND;fp=nope`)).throw(
      /invalid fingerprint/u,
    );
  });

  it('R585 should gate arrivals on exactly the version the parser accepts', () => {
    for (const fragment of [FRAGMENT, FRAGMENT.slice(1), '#v1']) {
      should(PAIRING_FRAGMENT_PATTERN.test(fragment)).be.true();
    }
    // `v2` belongs here rather than in the accepted list: the gate and the parser move together, and
    // a gate that admitted a version the parser refuses would turn a loud `unreadable` into a silent
    // cold screen for somebody who just scanned a QR.
    for (const fragment of ['#v2;url=a', 'v2', '#v3;url=a', '#v12;url=a', 'https://example.test', '', '#']) {
      should(PAIRING_FRAGMENT_PATTERN.test(fragment)).be.false();
    }
  });

  it('P73 should disclose a discovered rendezvous only beside a link, and never inside the pair URL', () => {
    const withRelay = invitation({ discoveredRelayUrl: RELAY_URL, reach: 'local-only' });
    should(PairingCodeMintResponseSchema.parse(withRelay)).deepEqual(withRelay);
    // THE DISCLOSURE DOES NOT CHANGE THE LINK. The `pairUrl` above is the ordinary three-field
    // fragment, and a response whose link named the rendezvous instead is refused — which is what
    // stops a future edit putting the address back into the QR.
    should(withRelay.pairUrl).equal(`${PAIR_APP}${FRAGMENT}`);
    should(withRelay.pairUrl).not.containEql('relay');
    const v2PairUrl = `${PAIR_APP}#v2;url=${encodeURIComponent(DAEMON_URL)};code=7F3K-Q2ND;fp=${daemonId};relay=${encodeURIComponent(RELAY_URL)}`;
    should(PairingCodeMintResponseSchema.safeParse({ ...withRelay, pairUrl: v2PairUrl }).success).be.false();
    should(
      PairingCodeMintResponseSchema.safeParse(
        invitation({ pairUrl: `${PAIR_APP}${FRAGMENT};relay=${encodeURIComponent(RELAY_URL)}` }),
      ).success,
    ).be.false();
    // A refusal has no address to disclose one beside, and an address the dial rule refuses is
    // refused at the schema rather than printed on a host's screen.
    should(PairingCodeMintResponseSchema.safeParse(refusal({ discoveredRelayUrl: RELAY_URL })).success).be.false();
    should(
      PairingCodeMintResponseSchema.safeParse(invitation({ discoveredRelayUrl: 'ws://relay.example' })).success,
    ).be.false();
  });

  it('P71 should let one narrowing say when another device can redeem, a discovered rendezvous included', () => {
    const withRelay = invitation({ discoveredRelayUrl: RELAY_URL, reach: 'local-only' });
    const outcome = pairingMintOutcome(PairingCodeMintResponseSchema.parse(withRelay));
    should(outcome).deepEqual({
      kind: 'invitation',
      daemonUrl: DAEMON_URL,
      pairUrl: `${PAIR_APP}${FRAGMENT}`,
      reach: 'local-only',
      discoveredRelayUrl: RELAY_URL,
    });
    // The QR question, answered once: a local-only direct address stops meaning unredeemable the
    // moment a rendezvous is published, and stays unredeemable when none is.
    if (outcome.kind !== 'invitation') throw new Error('expected an invitation');
    should(invitationRedeemableByAnotherDevice(outcome)).be.true();
    const plain = pairingMintOutcome(PairingCodeMintResponseSchema.parse(invitation()));
    if (plain.kind !== 'invitation') throw new Error('expected an invitation');
    should(invitationRedeemableByAnotherDevice(plain)).be.true();
    const localOnly = pairingMintOutcome(PairingCodeMintResponseSchema.parse(invitation({ reach: 'local-only' })));
    if (localOnly.kind !== 'invitation') throw new Error('expected an invitation');
    should(invitationRedeemableByAnotherDevice(localOnly)).be.false();
  });

  it('P13 should give a paired device no field for a key or a proof on the wire', () => {
    const paired = {
      id: deviceId,
      name: 'Phone',
      platform: 'browser',
      createdAt: '2026-08-03T12:00:00.000Z',
      lastSeenAt: '2026-08-03T12:00:00.000Z',
      idleExpiresAt: '2026-09-03T12:00:00.000Z',
      grants: {},
    };
    should(PairedDeviceSchema.safeParse(paired).success).be.true();
    for (const field of ['publicKey', 'deviceKey', 'proof', 'token', 'deviceToken', 'tokenHash'])
      should(PairedDeviceSchema.safeParse({ ...paired, [field]: 'MCowBQYDK2VwAyEAAAAA' }).success).be.false();
    should(Object.keys(PairedDeviceSchema.shape).filter(key => /key|proof|token|secret/iu.test(key))).deepEqual([]);
  });

  it('P128 should bound a device name by its schema: length, emptiness and control characters', () => {
    should(PairingDeviceNameSchema.parse('  Pixel 8  ')).equal('Pixel 8');
    should(PairingDeviceNameSchema.safeParse('').success).be.false();
    should(PairingDeviceNameSchema.safeParse('x'.repeat(PAIRING_DEVICE_NAME_MAX_LENGTH + 1)).success).be.false();
    should(PairingDeviceNameSchema.safeParse('Pix\u001b[31mel').success).be.false();
    should(PairedDeviceSchema.shape.name).equal(PairingDeviceNameSchema);
  });

  it('P14 should keep the code out of every URL path and query a mint may carry', () => {
    // The code rides only in the fragment, which no HTTP request sends; a query carrying it is refused.
    const mint = PairingCodeMintResponseSchema.parse(invitation());
    const url = new URL(mint.pairUrl as string);
    should(`${url.origin}${url.pathname}${url.search}`).not.containEql(mint.code);
    should(url.hash).containEql(`code=${mint.code}`);
    should(
      PairingCodeMintResponseSchema.safeParse(invitation({ pairUrl: `${PAIR_APP}/7F3K-Q2ND${FRAGMENT}` })).success,
    ).be.false();
  });

  it('P76 should read no fragment that carries a pairing code beside a share or download key', () => {
    should(() => parsePairingFragment(`${FRAGMENT};share=abc`)).throw(/share link/u);
    should(() => parsePairingFragment(`${FRAGMENT};k=abc`)).throw(/download link/u);
  });

  it('P83 should know one fragment version, v1, so the escape hatch stays unspent', () => {
    const seed = { daemonUrl: DAEMON_URL, code: '7F3K-Q2ND', daemonId } as const;
    should(formatPairingFragment(seed).startsWith('v1;')).be.true();
    should(PAIRING_FRAGMENT_PATTERN.test('#v1;url=a')).be.true();
    should(PAIRING_FRAGMENT_PATTERN.test('#v2;url=a')).be.false();
    should(() => parsePairingFragment(FRAGMENT.replace('#v1;', '#v2;'))).throw(/version/u);
  });

  it('R586 should hold a mint carrying a discovered rendezvous to the strict field set', () => {
    const withRelay = invitation({ discoveredRelayUrl: RELAY_URL, reach: 'local-only' });
    should(PairingCodeMintResponseSchema.parse(withRelay)).deepEqual(withRelay);
    should(PairingCodeMintResponseSchema.safeParse({ ...withRelay, relayCandidate: RELAY_URL }).success).be.false();
    should(PairingCodeMintResponseSchema.safeParse({ ...withRelay, grants: undefined }).success).be.false();
  });

  it('should distinguish local countdown state from a successful redemption acknowledgement', () => {
    should(
      PairingCodeStatusResponseSchema.parse({
        pairingId,
        status: 'pending',
        expiresAt: '2026-08-03T12:02:00.000Z',
      }),
    ).deepEqual({ pairingId, status: 'pending', expiresAt: '2026-08-03T12:02:00.000Z' });
    should(
      PairingCodeStatusResponseSchema.parse({
        pairingId,
        status: 'redeemed',
        expiresAt: '2026-08-03T12:02:00.000Z',
        redeemedAt: '2026-08-03T12:00:05.000Z',
        deviceName: '  Ernest phone  ',
      }),
    ).deepEqual({
      pairingId,
      status: 'redeemed',
      expiresAt: '2026-08-03T12:02:00.000Z',
      redeemedAt: '2026-08-03T12:00:05.000Z',
      deviceName: 'Ernest phone',
    });
    should(
      PairingCodeStatusResponseSchema.parse({
        pairingId,
        status: 'expired',
        expiresAt: '2026-08-03T12:02:00.000Z',
      }),
    ).deepEqual({ pairingId, status: 'expired', expiresAt: '2026-08-03T12:02:00.000Z' });
  });
});

describe('appOriginChoice (the address a plan card link is built on)', () => {
  it('should use the hosted app when nothing is set', () => {
    should(appOriginChoice(undefined)).eql({ origin: HOSTED_APP_ORIGIN });
    should(appOriginChoice('  ')).eql({ origin: HOSTED_APP_ORIGIN });
  });

  it('should use a machine’s own https address, keeping its path and dropping a trailing slash', () => {
    should(appOriginChoice('https://app.example/')).eql({ origin: 'https://app.example' });
    should(appOriginChoice(' https://box.example/fy/ ')).eql({ origin: 'https://box.example/fy' });
  });

  it('should allow plain http only on this machine', () => {
    should(appOriginChoice('http://localhost:5173')).eql({ origin: 'http://localhost:5173' });
    should(appOriginChoice('http://192.168.1.4').refused).be.a.String();
  });

  it.each([
    ['-x', 'starts with'],
    ['--help', 'starts with'],
    ['not a url', 'absolute'],
    ['ftp://app.example', 'https'],
    ['javascript:alert(1)', 'https'],
    ['https://me:pw@app.example', 'user name'],
  ])('should refuse %s and fall back to the hosted app', (setting, why) => {
    const choice = appOriginChoice(setting);
    should(choice.origin).equal(HOSTED_APP_ORIGIN);
    should(choice.refused).containEql(why);
  });
});
