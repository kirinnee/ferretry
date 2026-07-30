import { describe, it } from 'bun:test';
import should from 'should';
import * as push from '../../src/lib/push.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

/** A 65-byte P-256 point and a 16-byte auth secret at their fixed base64url widths (87 and 22). */
const P256DH = `BN${'x-_9'.repeat(21)}A`;
const AUTH = `${'ab-_'.repeat(5)}cd`;
const ENDPOINT_PREFIX = 'https://push.example.test/send/';
const ENDPOINT = `${ENDPOINT_PREFIX}aBc-123`;
const DEVICE_ID = 'push-3fa85f64-5717-4562-b3fc-2c963f66afa6';

const endpointOfLength = (length: number): string => `${ENDPOINT_PREFIX}${'a'.repeat(length - ENDPOINT_PREFIX.length)}`;

const events = { attention: true, question: false, failed: true, completed: false };
const prefs = { events, interactiveOnly: false };
const keys = { p256dh: P256DH, auth: AUTH };
const subscription = { endpoint: ENDPOINT, expirationTime: null, keys };
const registration = { deviceName: 'Pixel 8', subscription, prefs };
const deviceView = {
  id: DEVICE_ID,
  deviceName: 'Pixel 8',
  createdAt: INSTANT,
  updatedAt: LATER_INSTANT,
  expirationTime: null,
  prefs,
};
const payloadBase = {
  version: 1,
  eventKey: 'session-1:attention:7',
  title: 'Attention needed',
  body: 'Approve the destructive step.',
  tag: 'session-1',
  url: '/sessions/session-1',
  count: 1,
};
const sessionPayload = { ...payloadBase, sessionId: 'session-1', kind: 'attention' };

const pushCases: SchemaCase[] = [
  { name: 'notification kind', schema: push.PushNotificationKindSchema, value: 'attention' },
  { name: 'preferences', schema: push.PushPreferencesSchema, value: prefs },
  { name: 'browser subscription', schema: push.BrowserPushSubscriptionSchema, value: subscription },
  { name: 'register request', schema: push.RegisterPushDeviceRequestSchema, value: registration },
  { name: 'device view', schema: push.PushDeviceViewSchema, value: deviceView },
  { name: 'device list', schema: push.PushDeviceListResponseSchema, value: { devices: [deviceView] } },
  { name: 'vapid key', schema: push.VapidPublicKeyResponseSchema, value: { publicKey: P256DH } },
  { name: 'notification payload', schema: push.PushNotificationPayloadSchema, value: sessionPayload },
  { name: 'delivery result', schema: push.PushDeliveryResultSchema, value: { delivered: 2, failed: 0 } },
  { name: 'push error', schema: push.PushErrorCodeSchema, value: 'invalid' },
];

describe('push schemas', () => {
  it('should round-trip every public push schema', () => {
    // Arrange
    const cases = pushCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(push, cases);
  });

  it('should resolve every notification kind, error code, and payload variant', () => {
    // Arrange
    const kinds = ['attention', 'question', 'failed', 'completed'] as const;
    const codes = ['invalid', 'corrupt_store', 'not_found'] as const;
    const payloads = [sessionPayload, payloadBase];

    // Act + Assert
    for (const kind of kinds) should(push.PushNotificationKindSchema.parse(kind)).equal(kind);
    for (const code of codes) should(push.PushErrorCodeSchema.parse(code)).equal(code);
    for (const kind of kinds) {
      should(push.PushNotificationPayloadSchema.safeParse({ ...sessionPayload, kind }).success).be.true();
    }
    for (const value of payloads) should(push.PushNotificationPayloadSchema.parse(value)).deepEqual(value);
  });

  it('should require an exhaustive event preference map and normalise device names', () => {
    // Arrange
    const allOn = { events: { attention: true, question: true, failed: true, completed: true }, interactiveOnly: true };
    const allOff = {
      events: { attention: false, question: false, failed: false, completed: false },
      interactiveOnly: false,
    };

    // Act
    const parsedOn = push.PushPreferencesSchema.parse(allOn);
    const parsedOff = push.PushPreferencesSchema.parse(allOff);
    const padded = push.PushDeviceViewSchema.parse({ ...deviceView, deviceName: `  ${'a'.repeat(80)}  ` });

    // Assert
    should(parsedOn).deepEqual(allOn);
    should(parsedOff).deepEqual(allOff);
    should(padded.deviceName).equal('a'.repeat(80));
  });

  it('should accept boundary endpoints, tokens, expirations, and counts', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'endpoint at the 4096-character ceiling',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: endpointOfLength(4_096) },
      },
      {
        name: 'endpoint carrying a port, query, and fragment',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://push.example.test:8443/send/abc?ttl=60#f' },
      },
      {
        name: 'zero expiration',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, expirationTime: 0 },
      },
      {
        name: 'fractional millisecond expiration',
        schema: push.PushDeviceViewSchema,
        value: { ...deviceView, expirationTime: 1_774_000_000_000.5 },
      },
      {
        name: 'single-character device name',
        schema: push.RegisterPushDeviceRequestSchema,
        value: { ...registration, deviceName: 'a' },
      },
      {
        name: 'device name at the 80-character ceiling',
        schema: push.RegisterPushDeviceRequestSchema,
        value: { ...registration, deviceName: 'a'.repeat(80) },
      },
      { name: 'smallest legal count', schema: push.PushNotificationPayloadSchema, value: { ...payloadBase, count: 1 } },
      {
        name: 'empty body with populated title',
        schema: push.PushNotificationPayloadSchema,
        value: { ...payloadBase, body: '' },
      },
      { name: 'zeroed delivery counters', schema: push.PushDeliveryResultSchema, value: { delivered: 0, failed: 0 } },
      { name: 'empty device list', schema: push.PushDeviceListResponseSchema, value: { devices: [] } },
      {
        name: 'identical created and updated instants',
        schema: push.PushDeviceViewSchema,
        value: { ...deviceView, updatedAt: INSTANT },
      },
      {
        name: 'offset instants',
        schema: push.PushDeviceViewSchema,
        value: { ...deviceView, createdAt: '2026-07-30T20:00:00+08:00', updatedAt: '2026-07-30T20:01:00+08:00' },
      },
    ];

    // Act + Assert
    assertRoundTrips(cases);
  });

  it('should reject endpoints that are not credential-free HTTPS URLs', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'plaintext scheme',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'http://push.example.test/send/abc' },
      },
      {
        name: 'non-web scheme',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'ftp://push.example.test/send/abc' },
      },
      {
        name: 'embedded credentials',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://user:secret@push.example.test/send/abc' },
      },
      {
        name: 'username only',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://user@push.example.test/send/abc' },
      },
      {
        name: 'endpoint one character past the ceiling',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: endpointOfLength(4_097) },
      },
      {
        name: 'non-string endpoint',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 42 },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should refuse an unparseable endpoint instead of registering the device', () => {
    // Arrange
    const opaque = { ...registration, subscription: { ...subscription, endpoint: 'not-a-url' } };
    const empty = { ...registration, subscription: { ...subscription, endpoint: '' } };

    // Act + Assert
    should(push.RegisterPushDeviceRequestSchema.safeParse(opaque).success).be.false();
    should(push.RegisterPushDeviceRequestSchema.safeParse(empty).success).be.false();
  });

  it('should reject malformed subscription keys and unknown subscription fields', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'short p256dh',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, keys: { ...keys, p256dh: P256DH.slice(1) } },
      },
      {
        name: 'long p256dh',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, keys: { ...keys, p256dh: `${P256DH}A` } },
      },
      {
        name: 'standard-base64 alphabet in p256dh',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, keys: { ...keys, p256dh: `+${P256DH.slice(1)}` } },
      },
      {
        name: 'short auth secret',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, keys: { ...keys, auth: AUTH.slice(1) } },
      },
      {
        name: 'padded auth secret',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, keys: { ...keys, auth: `${AUTH.slice(0, 20)}==` } },
      },
      {
        name: 'missing auth secret',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, keys: { p256dh: P256DH } },
      },
      {
        name: 'unknown key field',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, keys: { ...keys, extra: 'x' } },
      },
      {
        name: 'unknown subscription field',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, ua: 'x' },
      },
      {
        name: 'omitted expiration',
        schema: push.BrowserPushSubscriptionSchema,
        value: { endpoint: ENDPOINT, keys },
      },
      {
        name: 'negative expiration',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, expirationTime: -1 },
      },
      {
        name: 'infinite expiration',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, expirationTime: Number.POSITIVE_INFINITY },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should reject malformed device registrations, identifiers, and preferences', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'empty device name',
        schema: push.RegisterPushDeviceRequestSchema,
        value: { ...registration, deviceName: '' },
      },
      {
        name: 'whitespace-only device name',
        schema: push.RegisterPushDeviceRequestSchema,
        value: { ...registration, deviceName: '   ' },
      },
      {
        name: 'device name past the ceiling',
        schema: push.RegisterPushDeviceRequestSchema,
        value: { ...registration, deviceName: 'a'.repeat(81) },
      },
      {
        name: 'control character in device name',
        schema: push.RegisterPushDeviceRequestSchema,
        value: { ...registration, deviceName: 'Pixel\n8' },
      },
      {
        name: 'invisible zero-width joiner in device name',
        schema: push.RegisterPushDeviceRequestSchema,
        value: { ...registration, deviceName: 'Pixel\u200d8' },
      },
      {
        name: 'unknown registration field',
        schema: push.RegisterPushDeviceRequestSchema,
        value: { ...registration, id: DEVICE_ID },
      },
      {
        name: 'partial event map',
        schema: push.PushPreferencesSchema,
        value: { events: { attention: true }, interactiveOnly: false },
      },
      {
        name: 'unknown event in the map',
        schema: push.PushPreferencesSchema,
        value: { events: { ...events, digest: true }, interactiveOnly: false },
      },
      {
        name: 'non-boolean event value',
        schema: push.PushPreferencesSchema,
        value: { events: { ...events, attention: 'yes' }, interactiveOnly: false },
      },
      { name: 'missing interactiveOnly flag', schema: push.PushPreferencesSchema, value: { events } },
      {
        name: 'device id without the push prefix',
        schema: push.PushDeviceViewSchema,
        value: { ...deviceView, id: '3fa85f64-5717-4562-b3fc-2c963f66afa6' },
      },
      {
        name: 'uppercase device id',
        schema: push.PushDeviceViewSchema,
        value: { ...deviceView, id: DEVICE_ID.toUpperCase() },
      },
      { name: 'short device id', schema: push.PushDeviceViewSchema, value: { ...deviceView, id: 'push-3fa85f64' } },
      {
        name: 'timestamp without a timezone',
        schema: push.PushDeviceViewSchema,
        value: { ...deviceView, createdAt: '2026-07-30T12:00:00' },
      },
      {
        name: 'date-only timestamp',
        schema: push.PushDeviceViewSchema,
        value: { ...deviceView, updatedAt: '2026-07-30' },
      },
      {
        name: 'device list holding a malformed device',
        schema: push.PushDeviceListResponseSchema,
        value: { devices: [{ ...deviceView, id: 'push-1' }] },
      },
      { name: 'empty vapid key', schema: push.VapidPublicKeyResponseSchema, value: { publicKey: '' } },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should reject incoherent payloads and delivery counters', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'session id without a kind',
        schema: push.PushNotificationPayloadSchema,
        value: { ...payloadBase, sessionId: 'session-1' },
      },
      {
        name: 'kind without a session id',
        schema: push.PushNotificationPayloadSchema,
        value: { ...payloadBase, kind: 'attention' },
      },
      {
        name: 'empty session id',
        schema: push.PushNotificationPayloadSchema,
        value: { ...sessionPayload, sessionId: '' },
      },
      {
        name: 'unknown notification kind',
        schema: push.PushNotificationPayloadSchema,
        value: { ...sessionPayload, kind: 'digest' },
      },
      {
        name: 'future payload version',
        schema: push.PushNotificationPayloadSchema,
        value: { ...payloadBase, version: 2 },
      },
      {
        name: 'unknown payload field',
        schema: push.PushNotificationPayloadSchema,
        value: { ...payloadBase, icon: '/icon.png' },
      },
      {
        name: 'unknown field beside a session payload',
        schema: push.PushNotificationPayloadSchema,
        value: { ...sessionPayload, icon: '/icon.png' },
      },
      { name: 'empty event key', schema: push.PushNotificationPayloadSchema, value: { ...payloadBase, eventKey: '' } },
      { name: 'empty title', schema: push.PushNotificationPayloadSchema, value: { ...payloadBase, title: '' } },
      { name: 'empty tag', schema: push.PushNotificationPayloadSchema, value: { ...payloadBase, tag: '' } },
      { name: 'empty url', schema: push.PushNotificationPayloadSchema, value: { ...payloadBase, url: '' } },
      { name: 'zero count', schema: push.PushNotificationPayloadSchema, value: { ...payloadBase, count: 0 } },
      { name: 'fractional count', schema: push.PushNotificationPayloadSchema, value: { ...payloadBase, count: 1.5 } },
      { name: 'negative delivered count', schema: push.PushDeliveryResultSchema, value: { delivered: -1, failed: 0 } },
      { name: 'fractional failed count', schema: push.PushDeliveryResultSchema, value: { delivered: 0, failed: 0.5 } },
      { name: 'missing failed count', schema: push.PushDeliveryResultSchema, value: { delivered: 1 } },
      { name: 'unknown push error code', schema: push.PushErrorCodeSchema, value: 'expired' },
    ];

    // Act + Assert
    assertRejects(cases);
  });
});
