/**
 * The `agenda` Settings tab: what buzzes this phone (the device's notification switch and its registrations, the
 * categories and quiet hours) and the Agenda mode a new ferret starts with.
 */

import type { PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { NotificationFilterSettingsView } from '../features/settings/notification-filter-settings.tsx';
import { NotificationSettingsView } from '../features/settings/notification-settings.tsx';
import { AgendaClientContext } from '../lib/agenda-client-context.tsx';
import { useNotificationPreferences } from '../shell.ts';

export function createAgendaSettings(client: PluginClient) {
  return function AgendaSettings(_props: SettingsProps) {
    const preferences = useNotificationPreferences();
    return (
      <AgendaClientContext.Provider value={client}>
        <div className="flex flex-col gap-4">
          <NotificationSettingsView
            permission={preferences.permission}
            devices={preferences.devices}
            currentDeviceId={preferences.currentDeviceId}
            onRevokeDevice={preferences.revokeDevice}
          />
          <NotificationFilterSettingsView
            preferences={preferences.filter}
            onCategoryChange={preferences.onCategoryChange}
            onQuietHoursChange={preferences.onQuietHoursChange}
          />
        </div>
      </AgendaClientContext.Provider>
    );
  };
}

export default createAgendaSettings;
