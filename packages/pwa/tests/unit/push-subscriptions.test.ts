import { FY_REQUEST_ID_HEADER, type PushDeviceView, type PushPreferences } from '@ferretry/protocol';
import { describe, expect, it } from 'bun:test';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import {
  applicationServerKey,
  fetchDaemonVapidKey,
  listDaemonPushDevices,
  pushSubscriptionJson,
  registerDaemonPushDevice,
  revokeDaemonPushDevice,
  type PushSubscriptionLike,
} from '../../src/lib/push-subscriptions.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });

const P256DH = 'B'.repeat(87);
const AUTH = 'C'.repeat(22);
const DEVICE_ID = 'push-00000000-0000-4000-8000-000000000000';

/** Every notification kind must be present: the wire schema records all four, not a subset. */
const prefs: PushPreferences = {
  events: { attention: true, question: true, failed: false, completed: false },
  interactiveOnly: true,
};

const device = {
  id: DEVICE_ID,
  deviceName: 'kirin phone',
  createdAt: '2026-07-31T10:00:00.000Z',
  updatedAt: '2026-07-31T10:05:00.000Z',
  expirationTime: null,
  prefs,
} satisfies PushDeviceView;

const subscription = (over: Record<string, unknown> = {}): PushSubscriptionLike => ({
  toJSON: () => ({
    endpoint: 'https://push.example.test/x',
    expirationTime: null,
    keys: { p256dh: P256DH, auth: AUTH },
    ...over,
  }),
});

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

const recorder = (body: unknown) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return response(body);
  };
  return { calls, fetcher };
};

/** A VAPID key is an uncompressed P-256 point: 0x04 then 64 bytes. */
const vapidKey = (bytes = 65): string => {
  const raw = new Uint8Array(bytes).fill(4);
  return btoa(String.fromCharCode(...raw))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
};

describe('daemon push enrolment', () => {
  it('reads the VAPID key from the paired daemon with its own bearer token', async () => {
    const { calls, fetcher } = recorder({ publicKey: vapidKey() });
    expect(await fetchDaemonVapidKey(daemonA, fetcher)).toBe(vapidKey());
    expect(calls[0]?.url).toBe('https://a.example.test/v1/push/vapid');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer token-a');
    expect(new Headers(calls[0]?.init?.headers).get(FY_REQUEST_ID_HEADER)).toBeNull();
  });

  it('lists only the devices enrolled with the daemon that was asked', async () => {
    const forA = recorder({ devices: [device] });
    expect(await listDaemonPushDevices(daemonA, forA.fetcher)).toEqual([device]);
    expect(forA.calls[0]?.url).toBe('https://a.example.test/v1/push/subscriptions');
    const forB = recorder({ devices: [] });
    expect(await listDaemonPushDevices(daemonB, forB.fetcher)).toEqual([]);
    expect(forB.calls[0]?.url).toBe('https://b.example.test/v1/push/subscriptions');
    expect(new Headers(forB.calls[0]?.init?.headers).get('authorization')).toBe('Bearer token-b');
  });

  it('enrols against one daemon, stamping a request id and the subscription body', async () => {
    const { calls, fetcher } = recorder(device);
    expect(await registerDaemonPushDevice(daemonA, subscription(), 'kirin phone', prefs, fetcher)).toEqual(device);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get(FY_REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      deviceName: 'kirin phone',
      subscription: {
        endpoint: 'https://push.example.test/x',
        expirationTime: null,
        keys: { p256dh: P256DH, auth: AUTH },
      },
      prefs,
    });
  });

  it('revokes by a daemon-issued device id and refuses any other shape', async () => {
    const { calls, fetcher } = recorder(device);
    expect(await revokeDaemonPushDevice(daemonA, DEVICE_ID, fetcher)).toEqual(device);
    expect(calls[0]?.url).toBe(`https://a.example.test/v1/push/subscriptions/${DEVICE_ID}`);
    expect(calls[0]?.init?.method).toBe('DELETE');
    await expect(revokeDaemonPushDevice(daemonA, '../../secrets', fetcher)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('refuses an endpoint that is not an HTTPS URL without credentials', () => {
    expect(() => pushSubscriptionJson(subscription())).not.toThrow();
    expect(() => pushSubscriptionJson(subscription({ endpoint: 'http://push.example.test/x' }))).toThrow();
    expect(() => pushSubscriptionJson(subscription({ endpoint: 'https://a:b@push.example.test/x' }))).toThrow();
  });

  it('refuses an incomplete browser subscription rather than storing a dead endpoint', () => {
    expect(() => pushSubscriptionJson(subscription({ endpoint: undefined }))).toThrow();
    expect(() => pushSubscriptionJson(subscription({ keys: { auth: AUTH } }))).toThrow();
    expect(() => pushSubscriptionJson(subscription({ keys: { p256dh: P256DH } }))).toThrow();
    expect(() => pushSubscriptionJson(subscription({ keys: { p256dh: 'short', auth: AUTH } }))).toThrow();
  });

  it('normalizes a missing expiry to null so the wire shape stays exact', () => {
    expect(pushSubscriptionJson(subscription({ expirationTime: undefined })).expirationTime).toBeNull();
    expect(pushSubscriptionJson(subscription({ expirationTime: 1_760_000_000 })).expirationTime).toBe(1_760_000_000);
  });

  it('decodes a base64url VAPID key into 65 bytes and rejects anything else', () => {
    expect(applicationServerKey(vapidKey()).byteLength).toBe(65);
    expect(() => applicationServerKey('not base64url!')).toThrow('invalid VAPID public key');
    expect(() => applicationServerKey(vapidKey(64))).toThrow('wrong length');
  });

  it('keeps daemon failure detail, falling back when the body is not JSON', async () => {
    await expect(
      listDaemonPushDevices(daemonA, async () => response({ error: 'nope', code: 'invalid' }, 400)),
    ).rejects.toMatchObject({ status: 400, message: 'nope', code: 'invalid' });
    await expect(
      listDaemonPushDevices(daemonA, async () => new Response('boom', { status: 500 })),
    ).rejects.toMatchObject({ status: 500, message: 'HTTP 500', code: undefined });
  });

  it('rejects a malformed daemon payload whole', async () => {
    await expect(fetchDaemonVapidKey(daemonA, async () => response({}))).rejects.toThrow();
    await expect(listDaemonPushDevices(daemonA, async () => response({ devices: [{ id: 'nope' }] }))).rejects.toThrow();
    await expect(
      registerDaemonPushDevice(daemonA, subscription(), 'phone', prefs, async () => response({ id: 'nope' })),
    ).rejects.toThrow();
  });
});
