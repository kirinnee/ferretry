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
  usePairedDaemons,
} from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useMemo, useSyncExternalStore } from 'react';
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
