/** The `warden` Settings tab: today's Warden card and settings form for the daemon the tab is on. */

import type { PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { useMemo } from 'react';
import { WardenConfigSurface } from '../features/warden/warden-config-card.tsx';
import { WardenClientContext } from '../lib/warden-client-context.tsx';
import { wardenClientFactory } from '../lib/warden-clients.ts';
import { useCurrentDaemon } from '../shell.ts';
import { useRouter } from '../ui.ts';

export function createWardenSettings(client: PluginClient) {
  return function WardenSettings(_props: SettingsProps) {
    const connection = useCurrentDaemon();
    const { navigate } = useRouter();
    const factory = useMemo(() => wardenClientFactory(connection, client), [connection]);
    return (
      <WardenClientContext.Provider value={factory}>
        <WardenConfigSurface connection={connection} unavailable="message" onNavigate={navigate} />
      </WardenClientContext.Provider>
    );
  };
}
