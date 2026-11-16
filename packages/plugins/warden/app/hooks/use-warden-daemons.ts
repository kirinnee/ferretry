/**
 * The daemons the Warden's views know of: the one a view was built for, and every paired daemon in the order and by
 * the names the ferrets bar shows them (a twin is told apart). Both come from the shell; this half keeps no list.
 */

import {
  daemonOfClient,
  daemonTitle,
  deviceControls,
  distinctDaemonName,
  machineDisplayOrder,
  useEveryDaemon,
  usePairedDaemons,
} from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { WardenMachine } from '../features/warden/warden-daemon-scope.ts';
import { type DaemonConnection, daemonConnection } from '../lib/machine.ts';

/** The identity a client the shell did not make is keyed by (a harness, a test). */
const THIS_DAEMON = 'this';

/** The daemon the screen, panel or settings tab is on: the one its client talks to, under the name it is paired by. */
export function useCurrentDaemon(client: PluginClient): DaemonConnection {
  const id = daemonOfClient(client) ?? THIS_DAEMON;
  const paired = usePairedDaemons().find(daemon => daemon.daemon === id);
  const name = paired === undefined ? undefined : daemonTitle(paired);
  return useMemo(() => daemonConnection({ daemonId: id, daemonName: name }), [id, name]);
}

const NO_CLIENTS: ReadonlyMap<string, PluginClient> = new Map();

const sameClients = (a: ReadonlyMap<string, PluginClient>, b: ReadonlyMap<string, PluginClient>): boolean =>
  a.size === b.size && [...a].every(([daemon, client]) => b.get(daemon) === client);

/**
 * The Warden's own client on every paired daemon where it runs, by daemon id (`useEveryDaemon`). The same map while
 * no client comes or goes: a machine's feed or grants answer moving re-reads nothing.
 */
export function useWardenClients(): ReadonlyMap<string, PluginClient> {
  const rows = useEveryDaemon();
  const held = useRef(NO_CLIENTS);
  const next = new Map(rows.map(row => [row.daemon, row.client]));
  if (!sameClients(held.current, next)) held.current = next.size === 0 ? NO_CLIENTS : next;
  return held.current;
}

const controls = deviceControls();

/** Every paired daemon, in the order and under the names the ferrets bar shows them. */
export function useWardenMachines(): readonly WardenMachine[] {
  const paired = usePairedDaemons();
  const saved = useSyncExternalStore(
    controls.subscribe,
    () => controls.snapshot().device.machineOrder,
    () => controls.snapshot().device.machineOrder,
  );
  return useMemo(
    () =>
      machineDisplayOrder(paired, saved).map(daemon => ({
        connection: daemonConnection({ daemonId: daemon.daemon, daemonName: daemonTitle(daemon) }),
        name: distinctDaemonName(daemon, paired),
      })),
    [paired, saved],
  );
}
