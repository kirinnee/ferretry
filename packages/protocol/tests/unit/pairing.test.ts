import { describe, it } from 'bun:test';
import {
  DaemonIdSchema,
  DeviceTokenSchema,
  PAIRING_CODE_MAX_ATTEMPTS,
  PAIRING_CODE_TTL_SECONDS,
  PAIRING_DEVICE_NAME_MAX_LENGTH,
  PairingCodeMintRequestSchema,
  PairingCodeMintResponseSchema,
  PairingCodeStatusResponseSchema,
  pairingMintOutcome,
  PairingRequestSchema,
  PairingResponseSchema,
} from '@ferretry/protocol';
import should from 'should';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const deviceToken = `fy_device_${'b'.repeat(43)}`;
const pairingId = `fy_pair_${'c'.repeat(22)}`;

const DAEMON_URL = 'https://workstation.example.test';
const PAIR_APP = 'https://ferretry.pages.dev/pair';
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
    const response = { deviceToken, daemonId, daemonName: 'workstation', capabilities: ['daemon-api'] };

    should(PairingResponseSchema.parse(response)).deepEqual(response);
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

  it('should refuse a link that does not say who can redeem it, in either direction', () => {
    // THE INVARIANT THIS RESPONSE GAINED. A link with no audience is what let a QR of a loopback
    // address reach a phone; an audience with no link would be a claim about nothing. Neither is a
    // value of this type, so the halves cannot travel apart.
    const { reach, ...noReach } = invitation();
    should(PairingCodeMintResponseSchema.safeParse(noReach).success).be.false();
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
