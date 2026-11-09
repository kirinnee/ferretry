/**
 * THE ONE DEVICE-WIDE NOTIFICATION FILTER STORE, made on first use. Settings draws it and edits it; the device view
 * (`views/agenda-filter-boot-view.tsx`) mirrors it to the worker at app boot. Both reach the SAME instance, so a change
 * made in Settings is the one the worker's document carries.
 */

import { DeviceNotificationFilterStore, type NotificationFilterStorage } from './notification-filter.ts';
import { browserNotificationFilterMirror } from './notification-filter-mirror.ts';

/** This browser's storage, or none where it is denied (memory state still works). */
const browserFilterStorage = (): NotificationFilterStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

let deviceFilter: DeviceNotificationFilterStore | undefined;

/** The one device-wide filter store. */
export const deviceFilterStore = (): DeviceNotificationFilterStore => {
  deviceFilter ??= new DeviceNotificationFilterStore(browserFilterStorage(), browserNotificationFilterMirror());
  return deviceFilter;
};
