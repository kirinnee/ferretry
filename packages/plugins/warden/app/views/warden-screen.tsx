/**
 * The `warden` screen: today's Warden page. One section per paired daemon (or the one the owner narrowed it to), each
 * bound to its own daemon's client, so nothing read from one is shown or acted on through another.
 */

import type { PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { useMemo } from 'react';
import { WardenOverviewSurface } from '../features/warden/warden-overview-surface.tsx';
import { WardenTotalsSurface } from '../features/warden/warden-totals-surface.tsx';
import { useWardenDaemonScope } from '../hooks/use-warden-daemon-scope.ts';
import { WardenClientContext } from '../lib/warden-client-context.tsx';
import { wardenClientFactory } from '../lib/warden-clients.ts';
import { WardenPage, type WardenSurfaceProps } from '../lib/warden-page.tsx';
import { useCurrentDaemon, useDeviceControls, useFerretsOf, useWardenMachines } from '../shell.ts';
import { useRouter } from '../ui.ts';

function WardenOverviewRoute({ connection, machineName }: WardenSurfaceProps) {
  const { navigate } = useRouter();
  const ferrets = useFerretsOf(connection.daemonId);
  return (
    <WardenOverviewSurface
      connection={connection}
      {...(machineName === undefined ? {} : { machineName })}
      ferrets={ferrets}
      onNavigate={navigate}
    />
  );
}

const WARDEN_SLOTS = { Overview: WardenOverviewRoute, Totals: WardenTotalsSurface } as const;

export function createWardenScreen(client: PluginClient) {
  return function WardenScreen(_props: ScreenProps) {
    const connection = useCurrentDaemon();
    const machines = useWardenMachines();
    const { remembered, remember } = useWardenDaemonScope(useDeviceControls());
    const factory = useMemo(() => wardenClientFactory(connection, client), [connection]);
    return (
      <WardenClientContext.Provider value={factory}>
        <WardenPage
          connection={connection}
          slots={WARDEN_SLOTS}
          machines={machines}
          remembered={remembered}
          onRemember={remember}
        />
      </WardenClientContext.Provider>
    );
  };
}
