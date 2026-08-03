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
  PairingRequestSchema,
  PairingResponseSchema,
} from '@ferretry/protocol';
import should from 'should';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const deviceToken = `fy_device_${'b'.repeat(43)}`;
const pairingId = `fy_pair_${'c'.repeat(22)}`;

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
  });

  it('should refuse malformed codes and unbounded or extra input', () => {
    should(PairingRequestSchema.safeParse({ code: '7F3KQ2ND', deviceName: 'phone' }).success).be.false();
    should(PairingRequestSchema.safeParse({ code: '7F3K-Q2N0', deviceName: 'phone' }).success).be.false();
    should(PairingRequestSchema.safeParse({ code: '7F3K-Q2ND', deviceName: '' }).success).be.false();
    should(
      PairingRequestSchema.safeParse({
        code: '7F3K-Q2ND',
        deviceName: 'x'.repeat(PAIRING_DEVICE_NAME_MAX_LENGTH + 1),
      }).success,
    ).be.false();
    should(PairingRequestSchema.safeParse({ code: '7F3K-Q2ND', deviceName: 'phone', admin: true }).success).be.false();
  });

  it('should validate the complete successful response and typed credentials', () => {
    const response = { deviceToken, daemonId, daemonName: 'workstation', capabilities: ['daemon-api'] };

    should(PairingResponseSchema.parse(response)).deepEqual(response);
    should(DeviceTokenSchema.parse(deviceToken)).equal(deviceToken);
    should(DaemonIdSchema.parse(daemonId)).equal(daemonId);
    should(DeviceTokenSchema.safeParse('device-token').success).be.false();
    should(DaemonIdSchema.safeParse('fingerprint').success).be.false();
  });

  it('should validate the bodyless local mint contract and its expiry metadata', () => {
    should(PairingCodeMintRequestSchema.parse({})).deepEqual({});
    should(PairingCodeMintRequestSchema.safeParse({ deviceName: 'phone' }).success).be.false();
    should(
      PairingCodeMintResponseSchema.parse({
        pairingId,
        code: '7F3K-Q2ND',
        ttlSeconds: 120,
        expiresAt: '2026-08-03T12:02:00.000Z',
        daemonId,
        daemonName: 'workstation',
        daemonUrl: 'https://workstation.example.test',
        pairUrl:
          'https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test;code=7F3K-Q2ND;fp=fy_daemon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).deepEqual({
      pairingId,
      code: '7F3K-Q2ND',
      ttlSeconds: 120,
      expiresAt: '2026-08-03T12:02:00.000Z',
      daemonId,
      daemonName: 'workstation',
      daemonUrl: 'https://workstation.example.test',
      pairUrl:
        'https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test;code=7F3K-Q2ND;fp=fy_daemon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
