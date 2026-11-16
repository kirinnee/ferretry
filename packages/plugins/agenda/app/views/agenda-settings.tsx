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
import { deviceFilterStore } from '../lib/device-filter-store.ts';

export function createAgendaSettings(runtime: AgendaRuntime) {
  return function AgendaSettings(_props: SettingsProps) {
    const store = deviceFilterStore();
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
