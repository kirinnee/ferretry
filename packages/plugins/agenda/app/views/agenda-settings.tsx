/**
 * The `agenda` Settings tab: what buzzes may show on this device — the four categories and quiet hours, device-wide
 * and local to this browser (`lib/notification-filter.ts`). This device's notification permission and its push
 * registrations are Access's (its `notifications` panel and Devices tab), so they are not drawn here.
 */

import type { SettingsProps } from '@ferretry/kernel/manifest';
import { useSyncExternalStore } from 'react';
import { NotificationFilterSettingsView } from '../features/settings/notification-filter-settings.tsx';
import { AgendaClientContext } from '../lib/agenda-client-context.tsx';
import type { AgendaRuntime } from '../lib/agenda-runtime.ts';
import { DeviceNotificationFilterStore, type NotificationFilterStorage } from '../lib/notification-filter.ts';
import { browserNotificationFilterMirror } from '../lib/notification-filter-mirror.ts';

/** This browser's storage, or none where it is denied (memory state still works). */
const browserStorage = (): NotificationFilterStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

let deviceFilter: DeviceNotificationFilterStore | undefined;

/** The one device-wide filter store, made on first use. */
const filterStore = (): DeviceNotificationFilterStore => {
  deviceFilter ??= new DeviceNotificationFilterStore(browserStorage(), browserNotificationFilterMirror());
  return deviceFilter;
};

export function createAgendaSettings(runtime: AgendaRuntime) {
  return function AgendaSettings(_props: SettingsProps) {
    const store = filterStore();
    const preferences = useSyncExternalStore(store.subscribe, store.get, store.get);
    return (
      <AgendaClientContext.Provider value={runtime.client}>
        <div className="flex flex-col gap-4">
          <NotificationFilterSettingsView
            preferences={preferences}
            onCategoryChange={(category, next) => store.set({ categories: { [category]: next } })}
            onQuietHoursChange={patch => store.set({ quietHours: patch })}
          />
        </div>
      </AgendaClientContext.Provider>
    );
  };
}
