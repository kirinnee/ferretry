import type { BrowserPushSubscription, PushPreferences } from '@ferretry/protocol';
import should from 'should';
import { PushError, type PushSubscriptionRecord } from '../../../src/lib/push/index.ts';

/** Shared fixtures for the push domain: real wire shapes, no crypto and no filesystem. */

export const AT = '2026-08-05T09:00:00.000Z';
export const LATER = '2026-08-05T10:00:00.000Z';

/** A paired device id the protocol accepts, so a record can be filed against one. */
export const deviceId = (marker: string) => `fy_device_id_${marker.repeat(22).slice(0, 22)}`;

/** A push enrolment id shaped exactly as the wire demands: the prefix plus a UUID. */
export const pushId = (marker: string) => `push-${marker.repeat(8).slice(0, 8)}-1111-4111-8111-111111111111`;

/**
 * A subscription with correctly sized key halves.
 *
 * The lengths are the protocol's, not decoration: `p256dh` is an uncompressed P-256 point (65 bytes,
 * 87 base64url characters) and `auth` is a 16-byte secret (22 characters). A fixture of the wrong size
 * would be rejected by the schema, which is what stops a test proving something the wire cannot carry.
 */
export function subscription(endpoint: string, fill = 4): BrowserPushSubscription {
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: Buffer.alloc(65, fill).toString('base64url'),
      auth: Buffer.alloc(16, fill).toString('base64url'),
    },
  };
}

export const allEvents: PushPreferences = {
  events: { attention: true, question: true, failed: true, completed: true },
  interactiveOnly: false,
};

export function record(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    id: pushId('a'),
    deviceId: deviceId('a'),
    deviceName: 'Pixel 8',
    subscription: subscription('https://push.example.test/send/one'),
    prefs: allEvents,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/**
 * The refusal a call raised, as a `PushError`.
 *
 * `rejectedWith(Class, { code })` is not typed by the assertion library, and a message pattern is the
 * wrong contract to assert: the CODE is what a client branches on, so it is what a test should name.
 */
export async function refused(promise: Promise<unknown>): Promise<PushError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  should(caught).be.instanceof(PushError);
  return caught as PushError;
}
