/**
 * THE BROWSER'S SIDE OF WEB PUSH, assembled once for the page: the device memory, the on/off preference, this
 * browser's notification permission and — where the browser can hold one — the per-machine service-worker enrolment.
 *
 * Every browser global is read HERE and handed to the pure enrolment code in `push-enrolment.ts` as a port, so that
 * code and the screens stay testable with plain objects. The stores are shared by every surface of the page (the
 * switch and the banner must agree), so they are made once; the enrolment is made per machine, because its worker is
 * labelled with the machine's name.
 */
import { browserDeviceName } from './device-name.ts';
import {
  containerPushEnrolment,
  DaemonPushDevices,
  type PushContainerLike,
  type PushEnrolment,
} from './push-enrolment.ts';
import { PushPreferences } from './push-preferences.ts';
import type { DaemonId, DaemonNotificationPreferences } from '../shell-pairing.ts';

export type NotificationPermissionState = 'unsupported' | 'default' | 'denied' | 'granted';

/** The signed worker every machine's push registration runs (docs/pwa-release-signing.md). */
const WORKER_FILE = '/sw.verified.js';

export interface PushHost {
  readonly devices: DaemonPushDevices;
  readonly preferences: DaemonNotificationPreferences;
  /** `null` where this browser cannot do Web Push at all. */
  readonly enrolment: (label: string) => PushEnrolment | null;
  readonly permission: () => NotificationPermissionState;
  /** Asks the browser. Must be reached from a tap. */
  readonly requestPermission: () => Promise<NotificationPermissionState>;
}

const storageOf = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const permissionOf = (): NotificationPermissionState =>
  typeof Notification === 'undefined'
    ? 'unsupported'
    : Notification.permission === 'denied'
      ? 'denied'
      : Notification.permission;

const canPush = (): boolean =>
  typeof window !== 'undefined' &&
  window.isSecureContext &&
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window;

let shared: (Pick<PushHost, 'devices' | 'preferences'> & { readonly name: string }) | undefined;

/** The page's push host. The two stores are made on first use and shared; the rest reads the browser each time. */
export const browserPushHost = (): PushHost => {
  shared ??= {
    devices: new DaemonPushDevices(storageOf()),
    preferences: new PushPreferences(storageOf()),
    name: browserDeviceName(),
  };
  const { name, devices, preferences } = shared;
  return {
    devices,
    preferences,
    enrolment: label =>
      canPush()
        ? containerPushEnrolment({
            container: navigator.serviceWorker as unknown as PushContainerLike,
            origin: window.location.origin,
            workerUrl: WORKER_FILE,
            label: (_daemon: DaemonId) => label,
            deviceName: name,
          })
        : null,
    permission: permissionOf,
    requestPermission: async () => {
      if (typeof Notification === 'undefined') return 'unsupported';
      await Notification.requestPermission();
      return permissionOf();
    },
  };
};
