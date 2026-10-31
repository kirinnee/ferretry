/**
 * The daemon-bound host of the combined Warden totals: it reads each shown daemon's status through that
 * daemon's own connection and hands the sums to the render-only line.
 */

import { useCallback, useMemo } from 'react';
import { readView, type WardenPollOptions } from '../../hooks/use-warden-poll.ts';
import { useWardenStatuses } from '../../hooks/use-warden-statuses.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { WardenCombinedTotals } from './warden-combined-totals.tsx';
import type { WardenMachine } from './warden-daemon-scope.ts';
import type { WardenOverviewClientFactory } from './warden-overview-surface.tsx';
import { combinedTodayTotals } from './warden-stats-model.ts';

export interface WardenTotalsSurfaceProps {
  readonly machines: readonly WardenMachine[];
  readonly createClient?: WardenOverviewClientFactory;
  readonly now?: () => number;
  readonly pollOptions?: Omit<WardenPollOptions, 'revision'>;
}

export function WardenTotalsSurface({
  machines,
  createClient: injected,
  now = Date.now,
  pollOptions = {},
}: WardenTotalsSurfaceProps) {
  const routed = useDaemonClient();
  const createClient: WardenOverviewClientFactory = injected ?? routed;
  const read = useCallback(
    async (daemon: DaemonConnection) => await (await createClient(daemon)).wardenStatus(),
    [createClient],
  );
  const connections = useMemo(() => machines.map(machine => machine.connection), [machines]);
  const statuses = useWardenStatuses(connections, read, pollOptions);
  const totals = combinedTodayTotals(
    connections.map(connection => {
      const state = statuses.get(connection.daemonId);
      return state === undefined ? undefined : readView(state);
    }),
    now(),
  );
  return <WardenCombinedTotals totals={totals} />;
}
