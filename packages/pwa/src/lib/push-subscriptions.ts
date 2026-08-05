import {
  BrowserPushSubscriptionSchema,
  PushDeviceListResponseSchema,
  PushDeviceViewSchema,
  RegisterPushDeviceRequestSchema,
  VapidPublicKeyResponseSchema,
  type BrowserPushSubscription,
  type PushDeviceView,
  type PushPreferences,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, DaemonResponseError, type DaemonFetch } from './runtime-models.ts';
import { FY_REQUEST_ID_HEADER } from '@ferretry/protocol';

/** VAPID P-256 public keys are uncompressed EC points: one tag byte plus X and Y. */
const VAPID_KEY_BYTES = 65;

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/**
 * Every push call names its daemon.
 *
 * This is the whole point of the module: a Web Push subscription is enrolled
 * WITH one daemon, which holds the endpoint and can push to this browser. The
 * device list, the VAPID key and every revocation therefore belong to that
 * daemon alone, and showing daemon A's enrolled devices while daemon B is
 * selected would misreport who can reach this browser.
 *
 * kteam's read-only guard ("this remote view is read-only" when no ambient
 * token existed) has no equivalent here and is not ported: a
 * `DaemonConnection` cannot be constructed without a device token, so the
 * unauthenticated case is gone structurally rather than checked at runtime.
 */
const pushJson = async (
  daemon: DaemonConnection,
  path: string,
  init: RequestInit,
  fetcher: DaemonFetch,
): Promise<unknown> => {
  const mutation = (init.method ?? 'GET').toUpperCase() !== 'GET';
  const request = daemonRequest(daemon, path, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(mutation ? { [FY_REQUEST_ID_HEADER]: crypto.randomUUID() } : {}),
    },
  });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return await response.json();
};

/**
 * Decodes the daemon's base64url VAPID key into the byte array the browser's
 * `pushManager.subscribe` requires. The length check is not decoration: a key
 * of the wrong size is rejected here rather than becoming an opaque
 * subscription failure inside the browser later.
 */
export const applicationServerKey = (publicKey: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(publicKey)) throw new Error('the daemon returned an invalid VAPID public key');
  const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
  const binary = atob(`${publicKey.replaceAll('-', '+').replaceAll('_', '/')}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.byteLength !== VAPID_KEY_BYTES)
    throw new Error('the daemon returned a VAPID public key with the wrong length');
  return bytes;
};

/** The browser subscription surface this module reads, so a test needs no service worker. */
export interface PushSubscriptionLike {
  toJSON(): {
    endpoint?: string | undefined;
    expirationTime?: number | null | undefined;
    keys?: Record<string, string> | undefined;
  };
}

/**
 * Projects a browser subscription into the wire shape, validated before it is
 * sent. An incomplete subscription is a browser-side failure and is refused
 * here, so the daemon never stores an endpoint it can never push to.
 */
export const pushSubscriptionJson = (subscription: PushSubscriptionLike): BrowserPushSubscription => {
  const encoded = subscription.toJSON();
  return BrowserPushSubscriptionSchema.parse({
    endpoint: encoded.endpoint,
    expirationTime: encoded.expirationTime ?? null,
    keys: { p256dh: encoded.keys?.p256dh, auth: encoded.keys?.auth },
  });
};

/** Reads the VAPID public key of the daemon this browser would enrol with. */
export const fetchDaemonVapidKey = async (
  daemon: DaemonConnection,
  fetcher: DaemonFetch = browserFetch,
): Promise<string> =>
  VapidPublicKeyResponseSchema.parse(await pushJson(daemon, '/v1/push/vapid', {}, fetcher)).publicKey;

/** Lists the devices enrolled with this daemon, and no other. */
export const listDaemonPushDevices = async (
  daemon: DaemonConnection,
  fetcher: DaemonFetch = browserFetch,
): Promise<readonly PushDeviceView[]> =>
  PushDeviceListResponseSchema.parse(await pushJson(daemon, '/v1/push/subscriptions', {}, fetcher)).devices;

/** Enrols this browser with one daemon under a reader-chosen device name. */
export const registerDaemonPushDevice = async (
  daemon: DaemonConnection,
  subscription: PushSubscriptionLike,
  deviceName: string,
  prefs: PushPreferences,
  fetcher: DaemonFetch = browserFetch,
): Promise<PushDeviceView> => {
  const body = RegisterPushDeviceRequestSchema.parse({
    deviceName,
    subscription: pushSubscriptionJson(subscription),
    prefs: { events: prefs.events, interactiveOnly: prefs.interactiveOnly },
  });
  return PushDeviceViewSchema.parse(
    await pushJson(daemon, '/v1/push/subscriptions', { method: 'POST', body: JSON.stringify(body) }, fetcher),
  );
};

/**
 * Revokes one enrolment from the daemon that issued it. Device ids are daemon-
 * local, so revoking against the wrong daemon would either 404 or, worse, match
 * an unrelated device — which is why there is no daemon-free overload.
 */
export const revokeDaemonPushDevice = async (
  daemon: DaemonConnection,
  deviceId: string,
  fetcher: DaemonFetch = browserFetch,
): Promise<PushDeviceView> => {
  const id = PushDeviceViewSchema.shape.id.parse(deviceId);
  return PushDeviceViewSchema.parse(
    await pushJson(daemon, `/v1/push/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetcher),
  );
};
