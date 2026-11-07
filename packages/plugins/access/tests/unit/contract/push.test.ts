import { describe, it } from 'bun:test';
import should from 'should';
import * as push from '../../../contract/push.ts';
import { INSTANT, LATER_INSTANT } from './fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

/** A 65-byte P-256 point and a 16-byte auth secret at their fixed base64url widths (87 and 22). */
const P256DH = `BN${'x-_9'.repeat(21)}A`;
const AUTH = `${'ab-_'.repeat(5)}cd`;
const ENDPOINT_PREFIX = 'https://fcm.googleapis.com/send/';
const ENDPOINT = `${ENDPOINT_PREFIX}aBc-123`;
const DEVICE_ID = 'push-3fa85f64-5717-4562-b3fc-2c963f66afa6';

const endpointOfLength = (length: number): string => `${ENDPOINT_PREFIX}${'a'.repeat(length - ENDPOINT_PREFIX.length)}`;

const keys = { p256dh: P256DH, auth: AUTH };
const subscription = { endpoint: ENDPOINT, expirationTime: null, keys };
const registration = { deviceName: 'Pixel 8', subscription };
const deviceView = {
  id: DEVICE_ID,
  deviceName: 'Pixel 8',
  createdAt: INSTANT,
  updatedAt: LATER_INSTANT,
  expirationTime: null,
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
const devicePairedPayload = { ...payloadBase, kind: 'device-paired' };
const clearPayload = {
  version: 1,
  kind: 'clear',
  eventKey: 'clear:session-1:A3:1',
  sessionId: 'session-1',
  tags: ['attention-session-1:A3', 'attention-session-1'],
};

const pushCases: SchemaCase[] = [
  { name: 'notification kind', schema: push.PushNotificationKindSchema, value: 'attention' },
  { name: 'browser subscription', schema: push.BrowserPushSubscriptionSchema, value: subscription },
  { name: 'register request', schema: push.RegisterPushDeviceRequestSchema, value: registration },
  { name: 'device view', schema: push.PushDeviceViewSchema, value: deviceView },
  { name: 'device list', schema: push.PushDeviceListResponseSchema, value: { devices: [deviceView] } },
  { name: 'vapid key', schema: push.VapidPublicKeyResponseSchema, value: { publicKey: P256DH } },
  { name: 'notification payload', schema: push.PushNotificationPayloadSchema, value: sessionPayload },
  { name: 'clear payload', schema: push.PushClearPayloadSchema, value: clearPayload },
  { name: 'push payload', schema: push.PushPayloadSchema, value: clearPayload },
  { name: 'seen request', schema: push.PushSeenRequestSchema, value: { sessionId: 'session-1', agendaId: 'A3' } },
  {
    name: 'seen response',
    schema: push.PushSeenResponseSchema,
    value: { cleared: true, tags: ['attention-session-1:A3'] },
  },
  { name: 'delivery result', schema: push.PushDeliveryResultSchema, value: { delivered: 2, failed: 0 } },
  { name: 'push error', schema: push.PushErrorCodeSchema, value: 'invalid' },
  { name: 'push urgency', schema: push.PushUrgencySchema, value: 'high' },
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
    const sessionKinds = ['attention', 'question', 'failed', 'completed'] as const;
    const codes = ['invalid', 'corrupt_store', 'not_found'] as const;
    const payloads = [sessionPayload, payloadBase, devicePairedPayload];

    // Act + Assert
    for (const kind of sessionKinds) should(push.PushNotificationKindSchema.parse(kind)).equal(kind);
    should(push.PushNotificationKindSchema.parse('device-paired')).equal('device-paired');
    for (const code of codes) should(push.PushErrorCodeSchema.parse(code)).equal(code);
    for (const kind of sessionKinds) {
      should(push.PushNotificationPayloadSchema.safeParse({ ...sessionPayload, kind }).success).be.true();
    }
    for (const value of payloads) should(push.PushNotificationPayloadSchema.parse(value)).deepEqual(value);
  });

  it('should normalise device names', () => {
    // Arrange + Act
    const padded = push.PushDeviceViewSchema.parse({ ...deviceView, deviceName: `  ${'a'.repeat(80)}  ` });

    // Assert
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
        name: 'endpoint carrying a query and a fragment, on each push service',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://fcm.googleapis.com/send/abc?ttl=60#f' },
      },
      {
        name: 'Apple push endpoint',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://web.push.apple.com/QW1h' },
      },
      {
        name: 'Mozilla push endpoint',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc' },
      },
      {
        name: 'Windows push endpoint',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://wns2-par02p.notify.windows.com/w/?token=abc' },
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
        value: { ...subscription, endpoint: 'http://fcm.googleapis.com/send/abc' },
      },
      {
        name: 'non-web scheme',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'ftp://fcm.googleapis.com/send/abc' },
      },
      {
        name: 'embedded credentials',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://user:secret@fcm.googleapis.com/send/abc' },
      },
      {
        name: 'username only',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://user@fcm.googleapis.com/send/abc' },
      },
      // The daemon POSTs to the endpoint from the host, so anything but a browser push service would be a
      // way to send requests to the host's own network.
      {
        name: 'a non-default port on a push service',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://fcm.googleapis.com:8443/send/abc' },
      },
      {
        name: 'a private address',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://10.0.0.5/send/abc' },
      },
      {
        name: 'a cloud metadata address',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://169.254.169.254/latest' },
      },
      {
        name: 'a host that only ends like a push service',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://evilpush.apple.com.example/x' },
      },
      {
        name: 'the bare suffix as a host',
        schema: push.BrowserPushSubscriptionSchema,
        value: { ...subscription, endpoint: 'https://push.apple.com/x' },
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

  it('should reject malformed device registrations and identifiers', () => {
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
        name: 'device-paired kind naming a session',
        schema: push.PushNotificationPayloadSchema,
        value: { ...sessionPayload, kind: 'device-paired' },
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

describe('high priority (the owner: "for 2FA notification, please make it high priority")', () => {
  it('should make a one-time code high and everything else normal, in one rule', () => {
    // Act / Assert
    should(push.pushUrgencyFor('one-time-code')).equal('high');
    should(push.pushUrgencyFor('approve-on-phone')).equal('high');
    should(push.pushUrgencyFor('other')).equal('normal');
    should(push.PUSH_URGENT_TTL_SECONDS).equal(600);
  });

  it('should carry only urgency high on a payload, and refuse any other word', () => {
    // Act / Assert
    should(push.PushNotificationPayloadSchema.parse({ ...sessionPayload, urgency: 'high' })).containDeep({
      urgency: 'high',
    });
    should(push.PushNotificationPayloadSchema.safeParse({ ...sessionPayload, urgency: 'low' }).success).be.false();
  });
});

describe('a clear (the owner: "when on 1 device is alr replied or resolved. then it should dismiss on other phones")', () => {
  it('should carry only version, kind, eventKey, sessionId and tags', () => {
    // Act
    const parsed = push.PushPayloadSchema.parse(clearPayload);

    // Assert
    should(Object.keys(parsed).sort()).deepEqual(['eventKey', 'kind', 'sessionId', 'tags', 'version']);
    should(push.PushClearPayloadSchema.parse(clearPayload)).deepEqual(clearPayload);
  });

  it('should refuse a clear that carries any content or an extra field', () => {
    // Arrange
    const smuggled = [
      { title: 'Deploy?' },
      { body: 'Approve the destructive step.' },
      { url: '/session/session-1' },
      { count: 1 },
      { subject: 'anything' },
    ];

    // Act / Assert
    for (const extra of smuggled) {
      should(push.PushClearPayloadSchema.safeParse({ ...clearPayload, ...extra }).success).be.false();
      should(push.PushPayloadSchema.safeParse({ ...clearPayload, ...extra }).success).be.false();
    }
  });

  it('should refuse no tags, too many tags, and an empty or spaced tag', () => {
    // Arrange
    const tags = (count: number): string[] => Array.from({ length: count }, (_, index) => `attention-s:A${index}`);

    // Act / Assert
    should(push.PushClearPayloadSchema.safeParse({ ...clearPayload, tags: [] }).success).be.false();
    should(
      push.PushClearPayloadSchema.safeParse({ ...clearPayload, tags: tags(push.PUSH_CLEAR_MAX_TAGS) }).success,
    ).be.true();
    should(
      push.PushClearPayloadSchema.safeParse({ ...clearPayload, tags: tags(push.PUSH_CLEAR_MAX_TAGS + 1) }).success,
    ).be.false();
    should(push.PushClearPayloadSchema.safeParse({ ...clearPayload, tags: [''] }).success).be.false();
    should(push.PushClearPayloadSchema.safeParse({ ...clearPayload, tags: ['two words'] }).success).be.false();
    should(push.PushClearPayloadSchema.safeParse({ ...clearPayload, tags: ['x'.repeat(201)] }).success).be.false();
    should(push.PushClearPayloadSchema.safeParse({ ...clearPayload, sessionId: '' }).success).be.false();
  });

  it('should never be a notification, and no notification may call itself a clear', () => {
    // Act / Assert
    should(push.PushNotificationPayloadSchema.safeParse(clearPayload).success).be.false();
    should(push.PushNotificationPayloadSchema.safeParse({ ...sessionPayload, kind: 'clear' }).success).be.false();
    should(push.PushNotificationPayloadSchema.safeParse({ ...payloadBase, kind: 'clear' }).success).be.false();
    should(push.PushNotificationKindSchema.safeParse('clear').success).be.false();
    should(push.PushPayloadSchema.parse(sessionPayload)).deepEqual(sessionPayload);
  });
});

describe('the seen request', () => {
  it('should name a session and an agenda id, and nothing else', () => {
    // Act / Assert
    should(push.PushSeenRequestSchema.safeParse({ sessionId: 'session-1', agendaId: 'A3' }).success).be.true();
    should(push.PushSeenRequestSchema.safeParse({ sessionId: 'session-1', agendaId: 'A0' }).success).be.false();
    should(push.PushSeenRequestSchema.safeParse({ sessionId: '', agendaId: 'A3' }).success).be.false();
    should(
      push.PushSeenRequestSchema.safeParse({ sessionId: 'session-1', agendaId: 'A3', deviceId: DEVICE_ID }).success,
    ).be.false();
    should(push.PushSeenResponseSchema.safeParse({ cleared: true, tags: [] }).success).be.true();
    should(push.PushSeenResponseSchema.safeParse({ cleared: true, tags: [], title: 'Deploy?' }).success).be.false();
    // As many tags as one board can name, and no more (review round 5).
    const tags = (count: number) => Array.from({ length: count }, (_, index) => `attention-s:A${index + 1}`);
    should(push.PUSH_SEEN_MAX_TAGS).equal(241);
    should(
      push.PushSeenResponseSchema.safeParse({ cleared: true, tags: tags(push.PUSH_SEEN_MAX_TAGS) }).success,
    ).be.true();
    should(
      push.PushSeenResponseSchema.safeParse({ cleared: true, tags: tags(push.PUSH_SEEN_MAX_TAGS + 1) }).success,
    ).be.false();
  });
});

describe('which push services let a push show nothing (review round 8)', () => {
  it('should classify every allowlisted service, and let only FCM and WNS show nothing', () => {
    // Act / Assert
    should(Object.keys(push.PUSH_SERVICE_ALLOWS_SILENT).sort()).deepEqual(
      [...push.PUSH_SERVICE_HOSTS, ...push.PUSH_SERVICE_HOST_SUFFIXES].sort(),
    );
    should(push.pushServiceAllowsSilent('FCM.googleapis.com')).be.true();
    should(push.pushServiceAllowsSilent('wns2-db5p.notify.windows.com')).be.true();
    should(push.pushServiceAllowsSilent('updates.push.services.mozilla.com')).be.false();
    should(push.pushServiceAllowsSilent('web.push.apple.com')).be.false();
    should(push.pushServiceAllowsSilent('notify.windows.com')).be.false();
    should(push.pushServiceAllowsSilent('push.example.test')).be.false();
  });
});

describe('agenda push tags', () => {
  it('should give an item its own tag and a stop the ferret’s', () => {
    // Act / Assert
    should(push.agendaItemPushTag('session-1', 'A3')).equal('attention-session-1:A3');
    should(push.agendaSessionPushTag('session-1')).equal('attention-session-1');
    should(
      push.PushClearPayloadSchema.safeParse({ ...clearPayload, tags: [push.agendaItemPushTag('s', 'A1')] }).success,
    ).be.true();
  });
});

describe('the seen request names a board the agenda store accepts (review round 1)', () => {
  it('should refuse a traversal, a space and an over-long id, and accept a session and the machine agenda', () => {
    // Act / Assert
    for (const sessionId of ['../x', ' session-1', 'session 1', 'a'.repeat(129)])
      should(push.PushSeenRequestSchema.safeParse({ sessionId, agendaId: 'A3' }).success).be.false();
    for (const sessionId of ['session-1', 'machine-agenda', 'a'.repeat(128), 'mw0cb26c-30d27327'])
      should(push.PushSeenRequestSchema.safeParse({ sessionId, agendaId: 'A3' }).success).be.true();
  });
});
