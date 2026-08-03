/**
 * WEB PUSH ENROLMENT, ONE DEVICE RECORD PER PAIRED DAEMON.
 *
 * `push-subscriptions.ts` already speaks the daemon's push API. What was missing
 * is the lifecycle around it: which browser subscription exists, which daemon it
 * is enrolled with, which device id this browser answers to for THAT daemon, and
 * what the reader is told when closed-app delivery cannot be provisioned.
 *
 * kteam kept all of that inside `hooks/useNotifications.ts` — a React hook
 * holding one module-global device id under one localStorage key, because there
 * was exactly one daemon to enrol with. Ferretry can hold several pairings at
 * once, and a Web Push subscription is enrolled WITH one daemon: that daemon
 * holds the endpoint, mints the device id, and is the only party that can revoke
 * it. A single remembered id would therefore make daemon A's device look enrolled
 * with daemon B, and a revoke would be sent to a daemon that never issued it.
 * So the device memory here is a map keyed by `DaemonId`, and every operation
 * names its connection.
 *
 * The reason this is domain-tier code rather than hook code is testability: the
 * enable, disable, preference-sync and revoke sequences each have a failure path
 * that a reader sees as different wording, and none of them needs React.
 */

import type { PushDeviceView, PushPreferences } from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { daemonId } from './daemon-connection.ts';
import type { DaemonNotificationPreferences } from './notification-preferences.ts';
import {
  applicationServerKey,
  fetchDaemonVapidKey,
  listDaemonPushDevices,
  registerDaemonPushDevice,
  revokeDaemonPushDevice,
  type PushSubscriptionLike,
} from './push-subscriptions.ts';
import type { DaemonFetch } from './runtime-models.ts';

/* ---------- capability ----------------------------------------------------- */

/**
 * The three facts Web Push needs, read by the composition root rather than here.
 * `secureContext` is asked as a fact and not derived from a protocol check:
 * loopback counts as secure, which is the normal case for a daemon on the same
 * machine, and a naive HTTPS test would disable the whole feature there.
 */
export interface WebPushCapabilities {
  readonly secureContext: boolean;
  readonly serviceWorker: boolean;
  readonly pushManager: boolean;
}

export const supportsWebPush = (capabilities: WebPushCapabilities): boolean =>
  capabilities.secureContext && capabilities.serviceWorker && capabilities.pushManager;

/* ---------- per-daemon device memory --------------------------------------- */

export const PUSH_DEVICE_STORAGE_KEY = 'fy-pwa-push-devices-by-daemon-v1';

export interface PushDeviceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Decodes the versioned envelope, discarding any row that is not a device id. */
export const parsePushDeviceStore = (raw: string | null): ReadonlyMap<DaemonId, string> => {
  if (raw === null) return new Map();
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.daemons)) return new Map();
    const ids = new Map<DaemonId, string>();
    for (const [rawDaemonId, deviceId] of Object.entries(value.daemons)) {
      if (rawDaemonId.trim() === '' || typeof deviceId !== 'string' || deviceId.trim() === '') continue;
      ids.set(daemonId(rawDaemonId), deviceId);
    }
    return ids;
  } catch {
    return new Map();
  }
};

/**
 * Which device id this browser answers to, per daemon.
 *
 * `clearDaemon` is the same seam the pairing registry calls on unpair, eviction
 * and credential rotation, so this store can be registered as a daemon-scoped
 * cache alongside the preference store.
 */
export class DaemonPushDevices {
  readonly #storage: PushDeviceStorage | null;
  readonly #ids: Map<DaemonId, string>;

  constructor(storage: PushDeviceStorage | null = null) {
    this.#storage = storage;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(PUSH_DEVICE_STORAGE_KEY) ?? null;
    } catch {
      // Denied storage is an ordinary browser mode; the endpoint still works and
      // the next enrolment re-identifies this browser by its endpoint.
    }
    this.#ids = new Map(parsePushDeviceStore(raw));
  }

  get(daemon: DaemonId): string | null {
    return this.#ids.get(daemon) ?? null;
  }

  /** `null` forgets this daemon's device without touching any other pairing. */
  remember(daemon: DaemonId, deviceId: string | null): void {
    if (deviceId === null) this.#ids.delete(daemon);
    else this.#ids.set(daemon, deviceId);
    this.#persist();
  }

  clearDaemon(daemon: DaemonId): boolean {
    const deleted = this.#ids.delete(daemon);
    if (deleted) this.#persist();
    return deleted;
  }

  #persist(): void {
    if (this.#storage === null) return;
    // A daemon fingerprint is opaque input, so a null-prototype dictionary keeps
    // keys such as `__proto__` as ordinary own keys rather than letting object
    // metaproperties alter what is persisted.
    const daemons = Object.create(null) as Record<string, string>;
    for (const [id, deviceId] of this.#ids) daemons[id] = deviceId;
    try {
      this.#storage.setItem(PUSH_DEVICE_STORAGE_KEY, JSON.stringify({ version: 1, daemons }));
    } catch {
      // Private mode and an exhausted quota must not break the live store.
    }
  }
}

/* ---------- the daemon push API, as a port -------------------------------- */

/**
 * The four daemon calls enrolment makes. A port rather than direct imports so a
 * suite can drive every failure path without a fetch stub, and so no caller can
 * accidentally reach one daemon's push API with another's connection.
 */
export interface DaemonPushService {
  vapidKey(connection: DaemonConnection): Promise<string>;
  list(connection: DaemonConnection): Promise<readonly PushDeviceView[]>;
  register(
    connection: DaemonConnection,
    subscription: PushSubscriptionLike,
    deviceName: string,
    preferences: PushPreferences,
  ): Promise<PushDeviceView>;
  revoke(connection: DaemonConnection, deviceId: string): Promise<PushDeviceView>;
}

export const daemonPushService = (fetcher: DaemonFetch = fetch): DaemonPushService => ({
  vapidKey: connection => fetchDaemonVapidKey(connection, fetcher),
  list: connection => listDaemonPushDevices(connection, fetcher),
  register: (connection, subscription, deviceName, preferences) =>
    registerDaemonPushDevice(connection, subscription, deviceName, preferences, fetcher),
  revoke: (connection, deviceId) => revokeDaemonPushDevice(connection, deviceId, fetcher),
});

/* ---------- the browser subscription surface ------------------------------ */

export interface PushSubscriptionHandle extends PushSubscriptionLike {
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionHandle | null>;
  subscribe(options: {
    readonly userVisibleOnly: true;
    readonly applicationServerKey: Uint8Array;
  }): Promise<PushSubscriptionHandle>;
}

export interface PushRegistrationLike {
  readonly pushManager: PushManagerLike;
}

/** The browser half of enrolment, injected so no global is read in here. */
export interface PushEnrolment {
  /** Resolves the ready registration, or rejects where there is none. */
  readonly registration: () => Promise<PushRegistrationLike>;
  /** The reader-facing name this browser enrols under. */
  readonly deviceName: () => string;
}

/* ---------- enrolment ------------------------------------------------------ */

export interface PushEnrolmentContext {
  readonly connection: DaemonConnection;
  readonly service: DaemonPushService;
  readonly devices: DaemonPushDevices;
  readonly preferences: DaemonNotificationPreferences;
  /** `null` where this browser cannot do Web Push at all. */
  readonly enrolment: PushEnrolment | null;
}

const subscribeForPush = async (
  registration: PushRegistrationLike,
  context: PushEnrolmentContext,
): Promise<PushSubscriptionHandle> => {
  const publicKey = await context.service.vapidKey(context.connection);
  return await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  });
};

/**
 * Enrols this browser with ONE daemon and remembers the device id it issued.
 *
 * `create: false` refuses to mint a new subscription, which is what a refresh
 * wants: it may confirm an existing enrolment but must never prompt the push
 * service into creating an endpoint the reader did not ask for.
 */
export const enrolDaemonPushDevice = async (
  context: PushEnrolmentContext,
  create: boolean,
): Promise<PushDeviceView> => {
  const { enrolment } = context;
  if (enrolment === null) throw new Error('this browser cannot register for Web Push');
  const registration = await enrolment.registration();
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? (create ? await subscribeForPush(registration, context) : null);
  if (subscription === null) throw new Error('this browser has no push subscription for this daemon');
  const device = await context.service.register(
    context.connection,
    subscription,
    enrolment.deviceName(),
    context.preferences.get(context.connection.daemonId),
  );
  context.devices.remember(context.connection.daemonId, device.id);
  return device;
};

/**
 * Drops this browser's local endpoint. Best effort by design: an already-absent
 * or browser-refused subscription is not a failure the reader can act on, and
 * the daemon-side copy is removed by the push service's next 404/410 anyway.
 */
export const unsubscribeLocalPush = async (enrolment: PushEnrolment): Promise<boolean> => {
  try {
    const registration = await enrolment.registration();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription === null) return false;
    return await subscription.unsubscribe();
  } catch {
    return false;
  }
};

/* ---------- the reader-facing delivery report ----------------------------- */

export type PushDeliveryStatus = 'idle' | 'checking' | 'active' | 'unavailable';

export interface PushDeliveryReport {
  readonly status: PushDeliveryStatus;
  readonly message: string | null;
  readonly devices: readonly PushDeviceView[];
  readonly currentDeviceId: string | null;
}

export const PUSH_UNSUPPORTED_MESSAGE =
  'Web Push is unavailable in this browser; notifications still appear while the app is open.';
export const PUSH_INACTIVE_MESSAGE =
  'Closed-app delivery is not active on this device; the app still shows changes while it is open.';
export const PUSH_UNREACHABLE_MESSAGE = 'Could not reach this daemon’s push service.';
export const PUSH_CREATE_FAILED_MESSAGE = 'Could not create a Web Push subscription with this daemon.';
export const PUSH_SYNC_FAILED_MESSAGE = 'Could not send the new notification preferences to this daemon.';
export const PUSH_REVOKE_FAILED_MESSAGE = 'Could not revoke that device with this daemon.';

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() !== '' ? error.message : fallback;

const failed = (context: PushEnrolmentContext, error: unknown, fallback: string): PushDeliveryReport => ({
  status: 'unavailable',
  message: errorMessage(error, fallback),
  devices: [],
  currentDeviceId: context.devices.get(context.connection.daemonId),
});

const unsupported = (context: PushEnrolmentContext): PushDeliveryReport => ({
  status: 'unavailable',
  message: PUSH_UNSUPPORTED_MESSAGE,
  devices: [],
  currentDeviceId: context.devices.get(context.connection.daemonId),
});

/**
 * Reads what closed-app delivery is actually doing for this daemon.
 *
 * The reader's stored `enabled` preference is the gate on confirming an
 * enrolment, not a live browser permission read: `enabled` only ever becomes
 * true through `enablePushDelivery`, which requires granted permission first, so
 * the durable preference is the honest record and the domain tier needs no
 * notification global.
 */
export const readPushDelivery = async (context: PushEnrolmentContext): Promise<PushDeliveryReport> => {
  if (context.enrolment === null) return unsupported(context);
  const daemon = context.connection.daemonId;
  try {
    let deviceId = context.devices.get(daemon);
    if (context.preferences.get(daemon).enabled) {
      const confirmed = await enrolDaemonPushDevice(context, false).catch(() => null);
      if (confirmed !== null) deviceId = confirmed.id;
    }
    const devices = await context.service.list(context.connection);
    const active = deviceId !== null && devices.some(device => device.id === deviceId);
    return {
      status: active ? 'active' : 'unavailable',
      message: active ? null : PUSH_INACTIVE_MESSAGE,
      devices,
      currentDeviceId: deviceId,
    };
  } catch (error) {
    return failed(context, error, PUSH_UNREACHABLE_MESSAGE);
  }
};

/**
 * Turns delivery on for this daemon. The caller owns the permission gesture and
 * must already hold granted permission — a preference that claims to notify
 * without it would be a capability the app does not have.
 *
 * The preference is stored even when Web Push cannot be provisioned: permission
 * still has value, because the live app can show notifications while it is open.
 */
export const enablePushDelivery = async (context: PushEnrolmentContext): Promise<PushDeliveryReport> => {
  context.preferences.set(context.connection.daemonId, { enabled: true });
  if (context.enrolment === null) return unsupported(context);
  try {
    const device = await enrolDaemonPushDevice(context, true);
    const devices = await context.service.list(context.connection);
    return { status: 'active', message: null, devices, currentDeviceId: device.id };
  } catch (error) {
    return failed(context, error, PUSH_CREATE_FAILED_MESSAGE);
  }
};

/** Turns delivery off, revoking this daemon's device and the local endpoint. */
export const disablePushDelivery = async (context: PushEnrolmentContext): Promise<PushDeliveryReport> => {
  const daemon = context.connection.daemonId;
  context.preferences.set(daemon, { enabled: false });
  const deviceId = context.devices.get(daemon);
  context.devices.remember(daemon, null);
  // An offline revoke leaves a daemon-side copy behind, which the push service
  // removes on its next rejected delivery. Unsubscribing locally is what stops
  // this browser receiving anything in the meantime.
  if (deviceId !== null) await context.service.revoke(context.connection, deviceId).catch(() => null);
  if (context.enrolment !== null) await unsubscribeLocalPush(context.enrolment);
  return await readPushDelivery(context);
};

/**
 * Stores changed event preferences and, when delivery is on, pushes them to the
 * daemon that holds this device. Answers `null` when there was nothing to send,
 * so a caller keeps the delivery readout it already had rather than flashing it.
 */
export const syncPushPreferences = async (
  context: PushEnrolmentContext,
  preferences: PushPreferences,
): Promise<PushDeliveryReport | null> => {
  const stored = context.preferences.set(context.connection.daemonId, {
    events: preferences.events,
    interactiveOnly: preferences.interactiveOnly,
  });
  if (!stored.enabled || context.enrolment === null) return null;
  try {
    await enrolDaemonPushDevice(context, false);
  } catch (error) {
    return failed(context, error, PUSH_SYNC_FAILED_MESSAGE);
  }
  return await readPushDelivery(context);
};

/**
 * Revokes one enrolment from the daemon that issued it. Revoking THIS browser
 * also unsubscribes its endpoint and turns the local switch off, so the UI never
 * claims delivery it no longer has.
 */
export const revokePushDevice = async (
  context: PushEnrolmentContext,
  deviceId: string,
): Promise<PushDeliveryReport> => {
  const daemon = context.connection.daemonId;
  try {
    await context.service.revoke(context.connection, deviceId);
  } catch (error) {
    return failed(context, error, PUSH_REVOKE_FAILED_MESSAGE);
  }
  if (deviceId === context.devices.get(daemon)) {
    context.devices.remember(daemon, null);
    context.preferences.set(daemon, { enabled: false });
    if (context.enrolment !== null) await unsubscribeLocalPush(context.enrolment);
  }
  return await readPushDelivery(context);
};
