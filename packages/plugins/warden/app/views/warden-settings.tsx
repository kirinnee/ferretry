/** The `warden` Settings tab: today's Warden card and settings form for the daemon the tab is on. */

import { useNoReach } from '@ferretry/app';
import type { PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { useMemo, useRef } from 'react';
import { WardenConfigSurface } from '../features/warden/warden-config-card.tsx';
import { useCurrentDaemon, useWardenClients } from '../hooks/use-warden-daemons.ts';
import { DaemonReachContext, WardenClientContext } from '../lib/warden-client-context.tsx';
import { daemonReach, wardenClientFactory } from '../lib/warden-clients.ts';
import { useRouter } from '../ui.ts';

export function createWardenSettings(client: PluginClient) {
  return function WardenSettings(_props: SettingsProps) {
    const connection = useCurrentDaemon(client);
    const others = useWardenClients();
    const { navigate } = useRouter();
    const whyNone = useNoReach();
    const live = useRef(others);
    live.current = others;
    const reach = useMemo(
      () => daemonReach(connection, client, { clients: () => live.current, whyNone }),
      [connection, whyNone],
    );
    const factory = useMemo(() => wardenClientFactory(reach), [reach]);
    return (
      <DaemonReachContext.Provider value={reach}>
        <WardenClientContext.Provider value={factory}>
          <WardenConfigSurface connection={connection} unavailable="message" onNavigate={navigate} />
        </WardenClientContext.Provider>
      </DaemonReachContext.Provider>
    );
  };
}
