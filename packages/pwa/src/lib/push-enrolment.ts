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
 * enable, disable, and revoke sequences each have a failure path
 * that a reader sees as different wording, and none of them needs React.
 *
 * ONE SUBSCRIPTION PER DAEMON, TOO. A browser subscription is bound to the VAPID
 * key of the daemon that created it, so one shared subscription let only the
 * first daemon deliver, made it the voice of every daemon's alerts, and let one
 * daemon's "off" switch silence the rest (docs/cross-daemon.md §4b). Each daemon
 * now enrols through its own service-worker registration (`push-scope.ts`), and
 * the old shared subscription is dropped the first time any daemon moves over.
 */

import type { PushDeviceView } from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { daemonId } from './daemon-connection.ts';
import { MACHINE_READ_DEADLINE_MS, withDeadline } from './machine-deadline.ts';
import type { DaemonNotificationPreferences } from './notification-preferences.ts';
import { pushMachineOf, pushScopePath, pushWorkerUrl } from './push-scope.ts';
import {
  applicationServerKey,
  fetchDaemonVapidKey,
  listDaemonPushDevices,
  type PushSubscriptionLike,
  registerDaemonPushDevice,
  revokeDaemonPushDevice,
} from './push-subscriptions.ts';
import { browserFetch, type DaemonFetch } from './runtime-models.ts';
import { trustedWorkerUrl } from './trusted-types.ts';

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
  ): Promise<PushDeviceView>;
  revoke(connection: DaemonConnection, deviceId: string): Promise<PushDeviceView>;
}

export const daemonPushService = (fetcher: DaemonFetch = browserFetch): DaemonPushService => ({
  vapidKey: connection => fetchDaemonVapidKey(connection, fetcher),
  list: connection => listDaemonPushDevices(connection, fetcher),
  register: (connection, subscription, deviceName) =>
    registerDaemonPushDevice(connection, subscription, deviceName, fetcher),
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

/** A daemon's own push registration, which turning delivery off removes outright. */
export interface MachinePushRegistrationLike extends PushRegistrationLike {
  unregister(): Promise<boolean>;
}

/** The browser half of enrolment, injected so no global is read in here. */
export interface PushEnrolment {
  /**
   * This daemon's own registration, registered now (or re-labelled) and active, so it can subscribe.
   * Rejects where the browser has none to give.
   */
  readonly register: (daemon: DaemonId) => Promise<MachinePushRegistrationLike>;
  /** This daemon's own registration if it already exists. Never registers one. */
  readonly existing: (daemon: DaemonId) => Promise<MachinePushRegistrationLike | null>;
  /** The app-wide registration, whose ONE subscription every daemon shared before. */
  readonly shared: () => Promise<PushRegistrationLike | null>;
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
  moving = false,
): Promise<PushDeviceView> => {
  const { enrolment } = context;
  if (enrolment === null) throw new Error('this browser cannot register for Web Push');
  const daemon = context.connection.daemonId;
  // A subscription every daemon shared, from before each had its own: moving THIS daemon over is the
  // reader's earlier "on", so it may mint a subscription even on a refresh, and the shared one goes.
  const shared = await sharedSubscription(enrolment);
  try {
    const found = await enrolment.existing(daemon);
    const mayCreate = create || moving || shared !== null;
    if (found === null && !mayCreate) throw new Error('this browser has no push subscription for this daemon');
    const registration = await enrolment.register(daemon);
    const existing = await registration.pushManager.getSubscription();
    if (existing === null && !mayCreate) throw new Error('this browser has no push subscription for this daemon');
    const subscription = existing ?? (await subscribeForPush(registration, context));
    const previous = context.devices.get(daemon);
    const device = await context.service.register(context.connection, subscription, enrolment.deviceName());
    context.devices.remember(daemon, device.id);
    // The daemon still lists the device it issued for the shared endpoint; it is this browser's old
    // self, so it is revoked rather than left to deliver into a subscription that is about to vanish.
    if (previous !== null && previous !== device.id)
      await context.service.revoke(context.connection, previous).catch(() => null);
    return device;
  } finally {
    // FAIL CLOSED: the shared subscription is the one voice a broken-into daemon could keep for every
    // machine, so it goes even when this move-over failed. The reader's "on" is still stored, and the
    // next refresh enrols this daemon on its own registration.
    if (shared !== null) await shared.unsubscribe().catch(() => false);
  }
};

/**
 * Moves EVERY paired daemon off the shared subscription, at app start (docs/cross-daemon.md §4b). Waiting
 * for each machine's notification settings to be opened left the first-enrolled machine the voice of
 * every other machine's alerts until somebody did. A daemon whose delivery is on is enrolled on its own
 * registration; one whose delivery is off only has the device it issued for the shared endpoint revoked.
 * The shared subscription is dropped whatever happens, and nothing here throws.
 *
 * EVERY MACHINE AT ONCE, EACH BOUNDED. This used to walk the machines one after another, so a machine
 * that never answered held every machine after it — and the unsubscribe — forever. Each machine now
 * moves on its own and gives up after its deadline; the others are never waiting on it.
 */
export const moveOffSharedPush = async (
  contexts: readonly PushEnrolmentContext[],
  deadlineMs: number = MACHINE_READ_DEADLINE_MS,
): Promise<void> => {
  const enrolment = contexts.find(context => context.enrolment !== null)?.enrolment ?? null;
  if (enrolment === null) return;
  const shared = await sharedSubscription(enrolment);
  if (shared === null) return;
  const moveOne = async (context: PushEnrolmentContext): Promise<unknown> => {
    const daemon = context.connection.daemonId;
    if (context.preferences.get(daemon).enabled) return await enrolDaemonPushDevice(context, false, true);
    const previous = context.devices.get(daemon);
    if (previous === null) return null;
    context.devices.remember(daemon, null);
    return await context.service.revoke(context.connection, previous);
  };
  await Promise.allSettled(contexts.map(context => withDeadline(moveOne(context), deadlineMs)));
  await shared.unsubscribe().catch(() => false);
};

/** The app-wide registration's subscription, if one survives from before per-daemon registrations. */
const sharedSubscription = async (enrolment: PushEnrolment): Promise<PushSubscriptionHandle | null> => {
  try {
    return (await (await enrolment.shared())?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
};

/**
 * Drops this browser's local endpoint. Best effort by design: an already-absent
 * or browser-refused subscription is not a failure the reader can act on, and
 * the daemon-side copy is removed by the push service's next 404/410 anyway.
 */
export const unsubscribeLocalPush = async (enrolment: PushEnrolment, daemon: DaemonId): Promise<boolean> => {
  try {
    const registration = await enrolment.existing(daemon);
    if (registration === null) return false;
    const subscription = await registration.pushManager.getSubscription();
    const dropped = subscription === null ? false : await subscription.unsubscribe();
    // Only THIS daemon's registration goes. Every other daemon keeps its own subscription.
    await registration.unregister();
    return dropped;
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
  if (context.enrolment !== null) await unsubscribeLocalPush(context.enrolment, daemon);
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
    if (context.enrolment !== null) await unsubscribeLocalPush(context.enrolment, daemon);
  }
  return await readPushDelivery(context);
};

/* ---------- the browser binding -------------------------------------------- */

/** The slice of `navigator.serviceWorker` per-daemon registration needs. */
export interface PushContainerLike {
  register(scriptUrl: string, options: { readonly scope: string }): Promise<unknown>;
  getRegistrations(): Promise<readonly unknown[]>;
}

interface WorkerStateLike {
  readonly state: string;
  readonly scriptURL: string;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

interface RegistrationShape extends MachinePushRegistrationLike {
  readonly scope: string;
  readonly active: WorkerStateLike | null;
  readonly installing: WorkerStateLike | null;
  readonly waiting: WorkerStateLike | null;
}

const isRegistration = (value: unknown): value is RegistrationShape =>
  typeof value === 'object' && value !== null && 'pushManager' in value && 'unregister' in value && 'scope' in value;

/** Resolves once the registration has an active worker: a push subscription needs one. */
const whenActive = async (registration: RegistrationShape): Promise<RegistrationShape> => {
  if (registration.active !== null) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (worker === null) throw new Error('this daemon’s push worker did not start');
  await new Promise<void>((resolve, reject) => {
    const onState = (): void => {
      if (worker.state === 'activated') {
        worker.removeEventListener('statechange', onState);
        resolve();
      } else if (worker.state === 'redundant') {
        worker.removeEventListener('statechange', onState);
        reject(new Error('this daemon’s push worker did not start'));
      }
    };
    worker.addEventListener('statechange', onState);
    onState();
  });
  return registration;
};

export interface ContainerPushEnrolmentDeps {
  readonly container: PushContainerLike;
  /** This page's origin: a registration scope is compared as a full URL. */
  readonly origin: string;
  /** The signed worker's own address (`/sw.verified.js`); every daemon registers that same file. */
  readonly workerUrl: string;
  /** The reader's label for a daemon, which the worker puts in front of each of its titles. */
  readonly label: (daemon: DaemonId) => string;
  readonly deviceName: string;
}

/** A daemon this browser is still paired with, by the label the reader gave it. */
export interface PairedPushMachine {
  readonly daemonId: DaemonId;
  readonly label: string;
}

/** {@link PushEnrolment} over a real service-worker container, plus the reconcile the app runs. */
export interface ContainerPushEnrolment extends PushEnrolment {
  /**
   * Drops the push registration of every daemon this browser is no longer paired with, and re-labels
   * one whose label the reader changed. Best effort: a failure here leaves delivery as it was.
   */
  readonly reconcile: (paired: readonly PairedPushMachine[]) => Promise<void>;
}

export const containerPushEnrolment = (deps: ContainerPushEnrolmentDeps): ContainerPushEnrolment => {
  const scopeOf = (daemon: DaemonId): string => new URL(pushScopePath(daemon), deps.origin).href;
  const registrations = async (): Promise<RegistrationShape[]> =>
    (await deps.container.getRegistrations()).filter(isRegistration);
  const register = async (daemon: DaemonId): Promise<RegistrationShape> => {
    const registered = await deps.container.register(
      trustedWorkerUrl(pushWorkerUrl(deps.workerUrl, deps.label(daemon))),
      {
        scope: pushScopePath(daemon),
      },
    );
    if (!isRegistration(registered)) throw new Error('this browser cannot hold a push subscription for this daemon');
    return await whenActive(registered);
  };
  return {
    register,
    existing: async daemon => (await registrations()).find(candidate => candidate.scope === scopeOf(daemon)) ?? null,
    shared: async () =>
      (await registrations()).find(candidate => candidate.scope === new URL('/', deps.origin).href) ?? null,
    deviceName: () => deps.deviceName,
    reconcile: async paired => {
      try {
        const labels = new Map(paired.map(machine => [String(machine.daemonId), machine.label]));
        for (const registration of await registrations()) {
          const worker = registration.active ?? registration.waiting ?? registration.installing;
          const machine = pushMachineOf(registration.scope, worker?.scriptURL ?? '');
          if (machine === null) continue;
          const label = labels.get(machine.daemonId);
          if (label === undefined) {
            // Unpaired: its daemon must not keep a way to put words on this screen.
            await (await registration.pushManager.getSubscription())?.unsubscribe();
            await registration.unregister();
          } else if (label !== machine.label) {
            await register(machine.daemonId as DaemonId);
          }
        }
      } catch {
        // Nothing the reader can act on; the next reconcile tries again.
      }
    },
  };
};
