/** The `warden` Settings tab: today's Warden card and settings form for the daemon the tab is on. */

import type { PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { WardenConfigSurface } from '../features/warden/warden-config-card.tsx';
import { useCurrentDaemon } from '../hooks/use-warden-daemons.ts';
import { useWardenReach } from '../hooks/use-warden-reach.ts';
import { DaemonReachContext, WardenClientContext } from '../lib/warden-client-context.tsx';
import { useRouter } from '../ui.ts';

export function createWardenSettings(client: PluginClient) {
  return function WardenSettings(_props: SettingsProps) {
    const connection = useCurrentDaemon(client);
    const { navigate } = useRouter();
    const { reach, factory } = useWardenReach(connection, client);
    return (
      <DaemonReachContext.Provider value={reach}>
        <WardenClientContext.Provider value={factory}>
          <WardenConfigSurface connection={connection} unavailable="message" onNavigate={navigate} />
        </WardenClientContext.Provider>
      </DaemonReachContext.Provider>
    );
  };
}
