import { describe, it } from 'bun:test';
import {
  DaemonIdSchema,
  DeviceTokenSchema,
  formatPairingFragment,
  invitationRedeemableByAnotherDevice,
  PAIRING_CODE_MAX_ATTEMPTS,
  PAIRING_CODE_TTL_SECONDS,
  PAIRING_DEVICE_NAME_MAX_LENGTH,
  PAIRING_FRAGMENT_PATTERN,
  PairingCodeMintRequestSchema,
  PairingCodeMintResponseSchema,
  PairingCodeStatusResponseSchema,
  type PairingLinkSeed,
  pairingLinkUrl,
  pairingMintOutcome,
  PairingRequestSchema,
  PairingResponseSchema,
  parsePairingFragment,
} from '@ferretry/protocol';
import should from 'should';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const deviceToken = `fy_device_${'b'.repeat(43)}`;
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

/**
 * A mint as a daemon older than the reach answers one: a link, and nothing saying who can use it.
 *
 * The address is the whole of the evidence, because the version that wrote this welded "where I
 * listen" into "where I can be reached" — so each case below is one bind an old daemon really had.
 */
const legacyInvitation = (daemonUrl: string) => ({
  ...minted,
  daemonUrl,
  pairUrl: `${PAIR_APP}#v1;url=${encodeURIComponent(daemonUrl)};code=7F3K-Q2ND;fp=${daemonId}`,
});

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

  it('should reject terminal and bidi injection while preserving bounded international names', () => {
    for (const deviceName of ['phone\x1b[31m', 'phone\rreplacement', 'phone\u202Ename', 'phone\u200B']) {
      should(PairingRequestSchema.safeParse({ code: '7F3K-Q2ND', deviceName }).success).be.false();
    }
    const boundary = '界'.repeat(PAIRING_DEVICE_NAME_MAX_LENGTH);
    should(PairingRequestSchema.parse({ code: '7F3K-Q2ND', deviceName: boundary }).deviceName).equal(boundary);
  });

  it('should validate the complete successful response and typed credentials', () => {
    const response = {
      deviceToken,
      daemonId,
      daemonName: 'workstation',
      capabilities: ['daemon-api'],
      carriers: [
        { kind: 'direct' as const, url: 'https://daemon.example' },
        { kind: 'relay' as const, url: 'wss://relay.example' },
      ],
    };

    should(PairingResponseSchema.parse(response)).deepEqual(response);
    should(PairingResponseSchema.parse({ ...response, carriers: undefined }).carriers).deepEqual([]);
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
    should(DeviceTokenSchema.parse(deviceToken)).equal(deviceToken);
    should(DaemonIdSchema.parse(daemonId)).equal(daemonId);
    should(DeviceTokenSchema.safeParse('device-token').success).be.false();
    should(DaemonIdSchema.safeParse('fingerprint').success).be.false();
    should(PairingResponseSchema.safeParse({ ...response, daemonName: 'workstation\u202E' }).success).be.false();
  });

  it('should validate the bodyless local mint contract and its expiry metadata', () => {
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

  it('should never yield a link that does not say who can redeem it, in either direction', () => {
    // THE INVARIANT THIS RESPONSE GAINED. A link with no audience is what let a QR of a loopback
    // address reach a phone; an audience with no link would be a claim about nothing. Neither is a
    // value of this type, so the halves cannot travel apart — a link that arrives without an
    // audience is answered from its own address rather than passed on unclassified.
    const { reach, ...noReach } = invitation();
    should(PairingCodeMintResponseSchema.parse(noReach).reach).equal('any-device');
    should(PairingCodeMintResponseSchema.safeParse({ ...invitation(), refusal: 'wildcard-bind' }).success).be.false();
    const { pairUrl, ...noLink } = invitation();
    should(PairingCodeMintResponseSchema.safeParse(noLink).success).be.false();
    should(PairingCodeMintResponseSchema.safeParse({ ...refusal(), pairUrl }).success).be.false();
    should(PairingCodeMintResponseSchema.safeParse({ ...refusal(), reach: 'any-device' }).success).be.false();
  });

  it('should carry a code with no link, so a daemon with no address still mints one', () => {
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

  it('should answer for a daemon older than the reach instead of refusing its whole mint', () => {
    // THE TWO ENDS UPGRADE ON DIFFERENT DAYS. The hosted browser ships when it is built and the
    // daemon upgrades when its owner gets round to it, so a response with a link and no `reach`
    // arrives for as long as one old daemon is running. Rejecting it would take the code away too.
    should(PairingCodeMintResponseSchema.parse(legacyInvitation(DAEMON_URL))).deepEqual({
      ...legacyInvitation(DAEMON_URL),
      reach: 'any-device',
    });
    // A loopback link becomes the honest local-only answer rather than the QR this release removed —
    // every spelling of loopback an old daemon could have bound and then advertised.
    for (const daemonUrl of ['http://127.0.0.1:7431', 'http://localhost:7431', 'http://[::1]:7431']) {
      should(PairingCodeMintResponseSchema.parse(legacyInvitation(daemonUrl))).deepEqual({
        ...legacyInvitation(daemonUrl),
        reach: 'local-only',
      });
    }
  });

  it('should fail an old wildcard link closed to the refusal the decision would have made', () => {
    // Nothing dials a wildcard authority, so it is not an address to classify: the link goes, the
    // code stays, and the reason is the one `decideAdvertisement` gives for the same bind.
    for (const daemonUrl of ['http://0.0.0.0:7431', 'http://[::]:7431']) {
      should(PairingCodeMintResponseSchema.parse(legacyInvitation(daemonUrl))).deepEqual(refusal());
      should(pairingMintOutcome(PairingCodeMintResponseSchema.parse(legacyInvitation(daemonUrl)))).deepEqual({
        kind: 'refusal',
        refusal: 'wildcard-bind',
      });
    }
  });

  it('should answer only the old shape, so no other disagreement is papered over', () => {
    // A link still may not disagree with the daemon it names, before or after the reach is filled in.
    should(
      PairingCodeMintResponseSchema.safeParse({
        ...legacyInvitation(DAEMON_URL),
        pairUrl: `${PAIR_APP}?code=7F3K-Q2ND`,
      }).success,
    ).be.false();
    // Half a link is not an old daemon's answer: it never sent one without the other.
    const { pairUrl, ...halfLink } = legacyInvitation(DAEMON_URL);
    should(PairingCodeMintResponseSchema.safeParse(halfLink).success).be.false();
    // Neither is a link beside a refusal, nor a mint that says nothing at all.
    should(
      PairingCodeMintResponseSchema.safeParse({ ...legacyInvitation(DAEMON_URL), refusal: 'wildcard-bind' }).success,
    ).be.false();
    should(PairingCodeMintResponseSchema.safeParse(minted).success).be.false();
    // Unknown keys are still refused outright, old shape or new.
    should(
      PairingCodeMintResponseSchema.safeParse({ ...legacyInvitation(DAEMON_URL), admin: true }).success,
    ).be.false();
  });

  it('should narrow one mint to one outcome, so no surface decides for itself', () => {
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

  it('should write the one fragment form from one codec, byte-identical to every shipped link', () => {
    const seed: PairingLinkSeed = { daemonUrl: DAEMON_URL, code: '7F3K-Q2ND', daemonId };
    should(`#${formatPairingFragment(seed)}`).equal(FRAGMENT);
    should(pairingLinkUrl(PAIR_APP, seed)).equal(`${PAIR_APP}${FRAGMENT}`);
    // The writer re-proves the code, so a mint composes the same spelling the schema demands back.
    should(formatPairingFragment({ ...seed, code: ' 7f3k q2nd ' })).containEql('code=7F3K-Q2ND');
  });

  it('should never write a rendezvous into a fragment, whatever a caller passes beside the seed', () => {
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

  it('should ignore an unrecognised field and refuse a repeated one', () => {
    // An unknown name is the next version arriving; a duplicate is a real ambiguity.
    should(parsePairingFragment(`${FRAGMENT};hint=later`)).deepEqual({
      daemonUrl: DAEMON_URL,
      code: '7F3K-Q2ND',
      daemonId,
    });
    should(() => parsePairingFragment(`${FRAGMENT};code=7F3K-Q2ND`)).throw(/repeats code/u);
    should(() => parsePairingFragment(`${FRAGMENT};hint=a;hint=b`)).throw(/repeats hint/u);
  });

  it('should ignore a relay field on a link rather than ever honouring one', () => {
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

  it('should name the exact reason a fragment cannot be a pairing link', () => {
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

  it('should gate arrivals on exactly the version the parser accepts', () => {
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

  it('should disclose a discovered rendezvous only beside a link, and never inside the pair URL', () => {
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

  it('should let one narrowing say when another device can redeem, a discovered rendezvous included', () => {
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
